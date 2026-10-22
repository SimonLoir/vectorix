#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# No host ports, existing data or .env files are used by this smoke test.
prefix="vectorix-smoke-${RANDOM}-$$"
network="${prefix}-network"
containers=()
images=()
cleanup() {
    result=$?
    if (( result != 0 )); then
        for container in "${containers[@]}"; do
            docker logs "$container" 2>&1 || true
        done
    fi
    for container in "${containers[@]}"; do
        docker rm -fv "$container" >/dev/null 2>&1 || true
    done
    docker network rm "$network" >/dev/null 2>&1 || true
    # CI publishes the exact images that passed these checks. Failed runs and
    # ordinary local runs always remove their temporary images.
    if (( result != 0 )) || [[ "${KEEP_IMAGES:-false}" != true ]]; then
        for image in "${images[@]}"; do
            docker image rm "$image" >/dev/null 2>&1 || true
        done
    fi
    exit "$result"
}
trap cleanup EXIT

for app in web admin api workers migrator; do
    file="apps/$app/Dockerfile"
    if [[ "$app" == migrator ]]; then file="packages/db/Dockerfile"; fi
    image="$prefix-$app:test"
    images+=("$image")
    docker build --progress=plain -f "$file" -t "$image" .
    docker image inspect --format "IMAGE_SIZE $app {{.Size}} bytes" "$image"
    image_user=$(docker image inspect --format '{{.Config.User}}' "$image")
    [[ -n "$image_user" && "$image_user" != root && "$image_user" != 0 ]]
done

# Check the complete pnpm store, not just top-level symlinks: optional peers
# must not smuggle Next.js, compilers or the Prisma CLI into backend images.
for app in api workers; do
    docker run --rm --entrypoint node "$prefix-$app:test" --input-type=module -e '
        import assert from "node:assert/strict";
        import { readdirSync, existsSync } from "node:fs";
        const packages = readdirSync("/app/node_modules/.pnpm");
        const unwanted = packages.filter(name => /^(next@|vite@|vitest@|eslint@|typescript@|@typescript\+|prisma@|@repo\+eslint-config)/.test(name));
        assert.deepEqual(unwanted, [], "Unexpected build/frontend dependencies");
        assert.deepEqual(readdirSync("/app").sort(), ["dist", "node_modules", "package.json"]);
        assert.ok(existsSync("/app/dist/index.mjs"));
    '
done

# Verify the bundled native PDF and isolated DOCX parser as the runtime user,
# with no development loader and no API/frontend parser dependencies.
docker run --rm --entrypoint node -v "$PWD/tests/documents/fixtures:/fixtures:ro" "$prefix-workers:test" --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { parseRichDocument, PDF_MEDIA_TYPE, DOCX_MEDIA_TYPE } from "/app/dist/document-parser.mjs";
    for (const [file, type, format, count] of [["text-fr-en.pdf", PDF_MEDIA_TYPE, "PDF", 2], ["structure-fr-en.docx", DOCX_MEDIA_TYPE, "DOCX", 7]]) {
        const result = await parseRichDocument(await readFile(`/fixtures/${file}`), type);
        assert.equal(result.format, format);
        assert.equal(result.sources.length, count);
        assert.ok(result.text.includes("français"));
    }
    await assert.rejects(parseRichDocument(await readFile("/fixtures/scanned.pdf"), PDF_MEDIA_TYPE), {code: "PDF_OCR_UNAVAILABLE"});
    await assert.rejects(parseRichDocument(await readFile("/fixtures/zipbomb.docx"), DOCX_MEDIA_TYPE), {code: "PARSER_LIMIT"});
    console.log("Production PDF and DOCX parsers passed");
'
docker run --rm --entrypoint node "$prefix-api:test" --input-type=module -e '
    import assert from "node:assert/strict";
    import { readdirSync, existsSync } from "node:fs";
    assert.deepEqual(readdirSync("/app/node_modules/.pnpm").filter(name => /^(yauzl@|saxes@)/.test(name)), []);
    assert.equal(existsSync("/usr/bin/pdftotext"), false);
'

docker network create "$network" >/dev/null
containers+=("$prefix-postgres" "$prefix-redis")
docker run -d --name "$prefix-postgres" --network "$network" --network-alias postgres \
    -e POSTGRES_PASSWORD=password -e POSTGRES_DB=vectorix_test postgres:18-alpine >/dev/null
docker run -d --name "$prefix-redis" --network "$network" --network-alias redis redis:8-alpine >/dev/null
for attempt in {1..60}; do
    if docker exec "$prefix-postgres" pg_isready -U postgres -d vectorix_test >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec "$prefix-postgres" pg_isready -U postgres -d vectorix_test

runtime_env=(
    -e DATABASE_URL=postgresql://postgres:password@postgres:5432/vectorix_test
    -e REDIS_URL=redis://redis:6379
    -e BETTER_AUTH_SECRET=container-smoke-test-secret-at-least-32-characters
    -e ENCRYPTION_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    -e BETTER_AUTH_URL=http://api:3001
    -e API_URL=http://api:3001
    -e TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3006
    -e ALLOW_ACCOUNT_CREATION=true
    -e ALLOW_ORGANIZATION_CREATION=true
    -e VECTORIX_WEB_PUSH_ENABLED=false
)
docker run --rm --network "$network" "${runtime_env[@]}" "$prefix-migrator:test"
# A second run must succeed without recreating or resetting the database.
docker run --rm --network "$network" "${runtime_env[@]}" "$prefix-migrator:test"

for app in api workers web admin; do
    containers+=("$prefix-$app")
    docker run -d --name "$prefix-$app" --network "$network" --network-alias "$app" \
        "${runtime_env[@]}" "$prefix-$app:test" >/dev/null
done

for app in api web admin; do
    case "$app" in api) port=3001; path=/ready ;; web) port=3000; path=/sign-in ;; admin) port=3006; path=/sign-in ;; esac
    for attempt in {1..60}; do
        if docker exec "$prefix-$app" node -e "fetch('http://127.0.0.1:$port$path').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
        sleep 1
    done
    docker exec "$prefix-$app" node -e "fetch('http://127.0.0.1:$port$path').then(r=>{if(!r.ok)throw Error(r.status);console.log('$app ready')})"
done

docker exec "$prefix-api" node --input-type=module -e '
    import assert from "node:assert/strict";
    const spec = await fetch("http://127.0.0.1:3001/spec.json");
    assert.equal(spec.status, 200);
    assert.ok(Object.keys((await spec.json()).paths).length > 0);
    const signup = await fetch("http://127.0.0.1:3001/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ name: "Container check", email: "container@example.test", password: "Temporary-container-check-73!" })
    });
    assert.equal(signup.status, 200);
    assert.ok((await signup.json()).user.id, "Prisma and authentication must work in the pruned runtime");
'

for app in web admin; do
    port=3000
    if [[ "$app" == admin ]]; then port=3006; fi
    docker exec -e TEST_PORT="$port" "$prefix-$app" node --input-type=module -e '
        import assert from "node:assert/strict";
        const base = `http://127.0.0.1:${process.env.TEST_PORT}`;
        const html = await (await fetch(`${base}/sign-in`)).text();
        assert.ok(html.includes("http://api:3001"), "API_URL must be supplied at runtime");
        const assets = [...html.matchAll(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/g)].map(match => match[1]);
        assert.ok(assets.some(path => path.includes(".js")));
        assert.ok(assets.some(path => path.includes(".css")));
        for (const path of new Set(assets)) {
            const response = await fetch(new URL(path.replaceAll("&amp;", "&"), base));
            assert.equal(response.status, 200, path);
            assert.ok(!response.headers.get("content-type")?.includes("text/html"), path);
        }
    '
done
docker exec "$prefix-web" node --input-type=module -e '
    import assert from "node:assert/strict";
    for (const path of ["/manifest.webmanifest", "/icons/app.svg", "/sw.js"]) {
        assert.equal((await fetch(`http://127.0.0.1:3000${path}`)).status, 200, path);
    }
'

# A completed scan proves the worker connected to Redis and queried PostgreSQL.
for attempt in {1..45}; do
    completed=$(docker exec "$prefix-redis" redis-cli ZCARD bull:notifications:completed)
    if (( completed > 0 )); then break; fi
    sleep 1
done
(( completed > 0 ))
[[ $(docker inspect --format '{{.State.Running}}' "$prefix-workers") == true ]]
# The vector image joins the same tested-image set published by CI.
images+=("$prefix-postgres-vector:test")
IMAGE_PREFIX="$prefix" MIGRATOR_IMAGE="$prefix-migrator:test" KEEP_IMAGES=true \
    bash scripts/test-infrastructure.sh
printf 'All six images and infrastructure passed production-runtime checks.\n'
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'image_prefix=%s\n' "$prefix" >> "$GITHUB_OUTPUT"
fi
