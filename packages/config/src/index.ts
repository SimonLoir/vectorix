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
    // Validate the exact bytes encryption.ts will consume, without trimming.
    const key = environment.ENCRYPTION_SECRET;
    if (!key || !key.trim())
        issues.push({ variable: 'ENCRYPTION_SECRET', reason: 'is not set' });
    else if (isPlaceholder(key.trim()))
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

/** Control characters must fail before WHATWG URL parsing can remove them. */
function hasUrlControls(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 32 || code === 127) return true;
    }
    return false;
}

/** Reject URL repairs and private suffixes before parsing a deployment base. */
function validHttpBase(value: string): URL | undefined {
    if (
        !value ||
        value.length > 8192 ||
        hasUrlControls(value) ||
        value.includes(' ') ||
        value.includes('\\') ||
        value.includes('?') ||
        value.includes('#')
    )
        return;
    const authority = /^https?:\/\/([^/?#]+)/iu.exec(value)?.[1];
    if (!authority || authority.includes('@') || authority.includes('*'))
        return;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) &&
            url.hostname &&
            !url.username &&
            !url.password
            ? url
            : undefined;
    } catch {
        return;
    }
}

function checkUrl(
    environment: Environment,
    name: string,
    issues: ConfigurationIssue[],
    required: boolean
) {
    const value = environment[name];
    if (!value || !value.trim()) {
        if (required)
            issues.push({
                variable: name,
                reason: 'must be set explicitly in production',
            });
        return;
    }
    const origins = name === 'TRUSTED_ORIGINS';
    const entries = origins
        ? value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
        : [value];
    const valid =
        !hasUrlControls(value) &&
        entries.length > 0 &&
        entries.every((entry) => {
            const url = validHttpBase(entry);
            return Boolean(url && (!origins || url.origin === entry));
        });
    if (!valid)
        issues.push({
            variable: name,
            reason: origins
                ? 'must contain non-empty serialized HTTP(S) origins'
                : 'must be an explicit HTTP(S) base without credentials, query or fragment',
        });
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
