#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Own one disposable loopback Redis. Never load .env or flush another server.
prefix="vectorix-redis-${RANDOM}-$$_test"
container_id=
cleanup() {
    result=$?
    if [[ -n "$container_id" ]]; then docker rm -fv "$container_id" >/dev/null 2>&1 || true; fi
    exit "$result"
}
trap cleanup EXIT
redis_default_password='default@pass:/%#é+%40'
redis_acl_username='vectorix@user:/%#é+'
redis_acl_password='acl@pass:/%#é+%40'
container_id=$(docker run -d --name "$prefix" --label vectorix.test=redis-auth \
    -p 127.0.0.1::6379 redis:8-alpine redis-server --requirepass "$redis_default_password")
export REDISCLI_AUTH="$redis_default_password"
ready=false
for attempt in {1..30}; do
    if [[ "$(docker exec -e REDISCLI_AUTH "$container_id" redis-cli --no-auth-warning ping 2>/dev/null || true)" == PONG ]]; then ready=true; break; fi
    sleep 1
done
[[ "$ready" == true ]]
[[ "$(docker exec "$container_id" redis-cli ping)" == 'NOAUTH Authentication required.' ]]
docker exec -e REDISCLI_AUTH "$container_id" redis-cli --no-auth-warning \
    ACL SETUSER "$redis_acl_username" on ">$redis_acl_password" '~*' '&*' +@all >/dev/null
redis_port=$(docker port "$container_id" 6379/tcp | cut -d: -f2)
export VECTORIX_REDIS_ISOLATED_TEST=1
export VECTORIX_REDIS_TEST_MODE=encoded
export VECTORIX_REDIS_TEST_USERNAME="$redis_acl_username" VECTORIX_REDIS_TEST_PASSWORD="$redis_acl_password"
userinfo=$(node -e 'process.stdout.write(encodeURIComponent(process.env.VECTORIX_REDIS_TEST_USERNAME)+":"+encodeURIComponent(process.env.VECTORIX_REDIS_TEST_PASSWORD))')
export REDIS_URL="redis://$userinfo@127.0.0.1:$redis_port/15"
# A configured URL password must win over this deliberately incorrect fallback.
export REDIS_PASSWORD=not-the-configured-redis-password
timeout --signal=TERM --kill-after=5s 60s pnpm --filter api exec tsx --test ../../packages/queues/src/redis-auth.integration.ts
timeout --signal=TERM --kill-after=5s 60s pnpm --filter api exec tsx --test ../../packages/queues/src/rate-limit.integration.ts
export VECTORIX_REDIS_TEST_MODE=fallback
export REDIS_URL="redis://127.0.0.1:$redis_port/15" REDIS_PASSWORD="$redis_default_password"
timeout --signal=TERM --kill-after=5s 60s pnpm --filter api exec tsx --test ../../packages/queues/src/redis-auth.integration.ts
printf 'Encoded ACL credentials, raw standalone-password queue/worker journeys and the shared rate-limit window passed on disposable Redis.\n'
