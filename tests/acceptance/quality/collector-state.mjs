/** Pure owned-state checks. Docker/process/database verification remains a separate guarded preflight. */
import { validateBootstrap } from './collector-protocol.mjs';
const require = (condition, label) => {
    if (!condition) throw new Error(label);
};
export const QUALITY_SERVICES = Object.freeze({
    postgres: [5432, '/var/lib/postgresql'],
    vector: [5432, '/var/lib/postgresql'],
    redis: [6379, '/data'],
    rustfs: [9000, '/data'],
    ollama: [11434, '/root/.ollama'],
});
export function validateQualityState(state, bootstrap, run) {
    require(/^[a-f0-9]{12}$/u.test(run) &&
        state.schemaVersion === 1 &&
        state.namespace === 'vectorix-m7c-quality' &&
        state.runId === run &&
        state.prefix === 'vectorix-m7c-quality-' + run, 'QUALITY_STATE_RUN');
    require(state.phase === 'READY_FOR_QUALITY_IMPORT', 'QUALITY_STATE_PHASE');
    require(state.applicationDatabase ===
        `vectorix_m7c_quality_app_${run}_test` &&
        state.vectorDatabase ===
            `vectorix_m7c_quality_vectors_${run}_test`, 'QUALITY_TEST_DATABASES');
    require(/^[a-f0-9]{40}$/u.test(state.commit) &&
        /^[a-f0-9]{64}$/u.test(
            state.lockfileSha256
        ), 'QUALITY_RELEASE_BINDING');
    require(Object.keys(state.resources).sort().join(',') ===
        Object.keys(QUALITY_SERVICES).sort().join(','), 'QUALITY_RESOURCE_SET');
    require(Object.keys(state.ports).sort().join(',') ===
        ['api', 'web', 'admin', ...Object.keys(QUALITY_SERVICES)]
            .sort()
            .join(','), 'QUALITY_PORT_SET');
    require(Object.values(state.ports).every(
        (port) => Number.isInteger(port) && port > 1024 && port < 65536
    ) &&
        new Set(Object.values(state.ports)).size ===
            8, 'QUALITY_DISTINCT_PORTS');
    require(state.apiOrigin === `http://127.0.0.1:${state.ports.api}` &&
        state.webOrigin ===
            `http://127.0.0.1:${state.ports.web}`, 'QUALITY_HTTP_ORIGINS');
    for (const [service, resource] of Object.entries(state.resources)) {
        require(resource.name === state.prefix + '-' + service &&
            /^[a-f0-9]{64}$/u.test(resource.id) &&
            /^sha256:[a-f0-9]{64}$/u.test(resource.imageId) &&
            /^[a-f0-9]{64}$/u.test(
                resource.volumeIdentity
            ), 'QUALITY_RESOURCE_IDENTITY');
        require(typeof resource.volume === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/u.test(
                resource.volume
            ), 'QUALITY_VOLUME_NAME');
        if (service !== 'ollama')
            require(resource.volume ===
                resource.name + '-data', 'QUALITY_NEW_STORE_VOLUME');
        else
            require(!resource.volume.startsWith(
                state.prefix
            ), 'QUALITY_PRESERVED_MODEL_VOLUME');
    }
    require(new Set(
        Object.values(state.resources).map((resource) => resource.id)
    ).size === 5 &&
        new Set(
            Object.values(state.resources).map(
                (resource) => resource.volumeIdentity
            )
        ).size === 5, 'QUALITY_DISTINCT_RESOURCES');
    const env = state.environment;
    require(env.NODE_ENV === 'production', 'QUALITY_PRODUCTION_RUNTIME');
    for (const [key, service, database] of [
        ['DATABASE_URL', 'postgres', state.applicationDatabase],
        ['VECTOR_DATABASE_URL', 'vector', state.vectorDatabase],
        ['VECTOR_DATABASE_PROVISIONING_URL', 'vector', state.vectorDatabase],
    ]) {
        const value = new URL(env[key]);
        require(['postgres:', 'postgresql:'].includes(value.protocol) &&
            value.hostname === '127.0.0.1' &&
            Number(value.port) === state.ports[service] &&
            value.pathname === '/' + database &&
            !value.search &&
            !value.hash &&
            value.username &&
            value.password, 'QUALITY_DATABASE_DSN');
    }
    const redis = new URL(env.REDIS_URL);
    require(redis.protocol === 'redis:' &&
        redis.hostname === '127.0.0.1' &&
        Number(redis.port) === state.ports.redis &&
        ['', '/', '/0'].includes(redis.pathname) &&
        !redis.search &&
        !redis.hash, 'QUALITY_REDIS_DSN');
    require(env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT ===
        `http://127.0.0.1:${state.ports.ollama}` &&
        env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS ===
            env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT &&
        !env.VECTORIX_DEFAULT_OLLAMA_API_KEY, 'QUALITY_ONLY_OWNED_OLLAMA');
    require(['COHERE', 'VOYAGE', 'OPENAI', 'MISTRAL'].every(
        (provider) =>
            !env[`VECTORIX_DEFAULT_${provider}_API_KEY`] &&
            !env[`VECTORIX_DEFAULT_${provider}_ENDPOINT`]
    ), 'QUALITY_NO_HOSTED_PROVIDERS');
    require(env.VECTORIX_DEFAULT_S3_ENDPOINT ===
        `http://127.0.0.1:${state.ports.rustfs}` &&
        env.VECTORIX_S3_ALLOWED_ENDPOINTS ===
            env.VECTORIX_DEFAULT_S3_ENDPOINT &&
        env.VECTORIX_DEFAULT_S3_BUCKET === `m7c-quality-${run}` &&
        env.VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE === 'true' &&
        env.VECTORIX_DEFAULT_S3_REGION === 'us-east-1' &&
        env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID &&
        env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY, 'QUALITY_OWNED_OBJECT_STORAGE');
    require(env.BETTER_AUTH_URL === state.apiOrigin &&
        env.API_URL === state.apiOrigin &&
        env.VECTORIX_WEB_URL === state.webOrigin &&
        env.TRUSTED_ORIGINS === state.webOrigin &&
        env.VECTOR_DATABASE_SCHEMA === 'vector_collections' &&
        env.VECTORIX_WEB_PUSH_ENABLED === 'false' &&
        !env.VECTORIX_DEFAULT_RESEND_API_KEY &&
        !env.VECTORIX_DEFAULT_SMTP_HOST &&
        !env.VECTORIX_FEATURE_PROVIDER_URL, 'QUALITY_RUNTIME_BOUNDARIES');
    require(Object.keys(state.processes).sort().join(',') ===
        'api,workers', 'QUALITY_REQUIRED_PROCESSES');
    for (const [service, value] of Object.entries(state.processes))
        require(Number.isInteger(value.pid) &&
            value.pid > 1 &&
            /^\d+$/u.test(value.startTicks) &&
            /^[a-f0-9-]{36}$/u.test(value.bootId) &&
            /^[a-f0-9]{64}$/u.test(value.entrySha256) &&
            value.service === service, 'QUALITY_PROCESS_IDENTITY');
    validateBootstrap(bootstrap, state);
    return state;
}
