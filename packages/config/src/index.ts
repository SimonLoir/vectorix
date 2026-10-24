/** Server processes that validate their configuration at startup. */
export type RuntimeService = 'api' | 'workers';

type Environment = Readonly<Record<string, string | undefined>>;

/** One configuration problem; messages name variables, never their values. */
export type ConfigurationIssue = Readonly<{ variable: string; reason: string }>;

/** Values published in `.env.example` that must never sign or encrypt production data. */
export const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
    'replace-with-a-random-secret-at-least-32-characters',
    'replace-with-64-random-hex-characters',
]);

const HEX_KEY = /^[0-9a-f]{64}$/iu;

function present(environment: Environment, name: string) {
    const value = environment[name]?.trim();
    return value === '' ? undefined : value;
}

function isPlaceholder(value: string) {
    return PLACEHOLDER_VALUES.has(value) || /^replace-with-/iu.test(value);
}

function checkSecrets(
    environment: Environment,
    service: RuntimeService,
    issues: ConfigurationIssue[]
) {
    if (service === 'api') {
        const secret = present(environment, 'BETTER_AUTH_SECRET');
        if (!secret)
            issues.push({
                variable: 'BETTER_AUTH_SECRET',
                reason: 'is not set',
            });
        else if (isPlaceholder(secret))
            issues.push({
                variable: 'BETTER_AUTH_SECRET',
                reason: 'still uses the published placeholder; run pnpm setup:env or generate a random value',
            });
        else if (secret.length < 32)
            issues.push({
                variable: 'BETTER_AUTH_SECRET',
                reason: 'must be at least 32 characters',
            });
    }
    const key = present(environment, 'ENCRYPTION_SECRET');
    if (!key)
        issues.push({ variable: 'ENCRYPTION_SECRET', reason: 'is not set' });
    else if (isPlaceholder(key))
        issues.push({
            variable: 'ENCRYPTION_SECRET',
            reason: 'still uses the published placeholder; generate 64 random hex characters',
        });
    else if (!HEX_KEY.test(key))
        issues.push({
            variable: 'ENCRYPTION_SECRET',
            reason: 'must be exactly 64 hexadecimal characters (32 bytes)',
        });
    else if (/^(.)\1*$/u.test(key))
        issues.push({
            variable: 'ENCRYPTION_SECRET',
            reason: 'must not repeat a single character',
        });
}

function checkUrl(
    environment: Environment,
    name: string,
    issues: ConfigurationIssue[],
    required: boolean
) {
    const value = present(environment, name);
    if (!value) {
        if (required)
            issues.push({
                variable: name,
                reason: 'must be set explicitly in production',
            });
        return;
    }
    for (const entry of name === 'TRUSTED_ORIGINS'
        ? value.split(',')
        : [value]) {
        if (!entry.trim()) continue;
        try {
            const url = new URL(entry.trim());
            if (!['http:', 'https:'].includes(url.protocol))
                throw new Error('Unsupported URL scheme.');
        } catch {
            issues.push({
                variable: name,
                reason: 'must contain HTTP(S) URLs',
            });
            return;
        }
    }
}

/**
 * Collect configuration problems for one service without reading values into
 * messages. Origins and links are required only in production, where silent
 * localhost fallbacks would produce broken or unsafe behavior.
 */
export function findConfigurationIssues(
    service: RuntimeService,
    environment: Environment
): ConfigurationIssue[] {
    const production = environment.NODE_ENV === 'production';
    const issues: ConfigurationIssue[] = [];
    if (!present(environment, 'DATABASE_URL'))
        issues.push({ variable: 'DATABASE_URL', reason: 'is not set' });
    checkSecrets(environment, service, issues);
    if (service === 'api') {
        checkUrl(environment, 'BETTER_AUTH_URL', issues, production);
        checkUrl(environment, 'TRUSTED_ORIGINS', issues, production);
        checkUrl(environment, 'API_URL', issues, false);
        checkUrl(environment, 'VECTORIX_WEB_URL', issues, false);
    } else checkUrl(environment, 'VECTORIX_WEB_URL', issues, production);
    return issues;
}

/**
 * Validate configuration once at process startup. In production any issue
 * stops the process with a sanitized list; elsewhere issues are warnings so
 * local development keeps working. Returns the issues for logging or tests.
 */
export function assertRuntimeConfiguration(
    service: RuntimeService,
    environment: Environment = process.env,
    warn: (message: string) => void = console.warn
): ConfigurationIssue[] {
    const issues = findConfigurationIssues(service, environment);
    if (issues.length === 0) return issues;
    const summary = issues
        .map(({ variable, reason }) => `- ${variable} ${reason}`)
        .join('\n');
    if (environment.NODE_ENV === 'production')
        throw new Error(
            `Invalid ${service} configuration; refusing to start:\n${summary}`
        );
    warn(
        `[config] ${service} configuration issues (development only):\n${summary}`
    );
    return issues;
}
