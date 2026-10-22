type RedisEnvironment = Readonly<{
    REDIS_URL?: string;
    REDIS_PASSWORD?: string;
}>;

/**
 * Parse deployment options without opening Redis connections. URL userinfo is
 * decoded exactly once; the legacy standalone password is already a raw value.
 * Keep configuration failures free of the URL, credentials and parser causes.
 */
export function buildRedisConnection(environment: RedisEnvironment) {
    try {
        const url = new URL(environment.REDIS_URL ?? 'redis://localhost:6379');
        return {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username
                ? decodeURIComponent(url.username)
                : undefined,
            password: url.password
                ? decodeURIComponent(url.password)
                : (environment.REDIS_PASSWORD ?? undefined),
            db: Number(url.pathname.slice(1) || 0),
            ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
        };
    } catch {
        throw new Error('Redis connection configuration is invalid.');
    }
}
