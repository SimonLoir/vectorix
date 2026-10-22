import { APIError } from 'better-auth/api';

type PasswordResetUrlEnvironment = Readonly<
    Partial<Record<'VECTORIX_WEB_URL' | 'WEB_URL' | 'APP_URL', string>>
>;

const publicWebUrlEnvKeys = ['VECTORIX_WEB_URL', 'WEB_URL', 'APP_URL'] as const;

/** Keep defaults independent of each consumer's ambient ProcessEnv typings. */
function readCanonicalEnvironment(): PasswordResetUrlEnvironment {
    return {
        VECTORIX_WEB_URL: process.env.VECTORIX_WEB_URL,
        WEB_URL: process.env.WEB_URL,
        APP_URL: process.env.APP_URL,
    };
}

function unavailable(): APIError {
    return new APIError('SERVICE_UNAVAILABLE', {
        code: 'PASSWORD_RESET_UNAVAILABLE',
        message: 'Password reset is temporarily unavailable.',
    });
}

/** Resolve the first configured URL without exposing invalid configuration. */
function configuredPublicWebUrl(environment: PasswordResetUrlEnvironment): URL {
    const configuredRaw = publicWebUrlEnvKeys
        .map((key) => environment[key])
        .find((value) => value && value.trim().length > 0);

    // Inspect the selected raw value before trimming: URL parsing can remove or
    // encode controls, which must make configuration invalid instead.
    if (configuredRaw) {
        for (const character of configuredRaw) {
            const code = character.codePointAt(0);
            if (code === undefined || code <= 0x1f || code === 0x7f) {
                throw unavailable();
            }
        }
    }
    const configured = configuredRaw?.trim();

    // WHATWG URL parsing accepts shorthand and normalizes backslashes. Only an
    // explicit HTTP(S) authority without credentials or URL suffixes is valid.
    if (
        !configured ||
        !/^https?:\/\/[^/?#\\\s]+(?:\/[^?#\\\s]*)?$/i.test(configured) ||
        configured.includes('?') ||
        configured.includes('#')
    ) {
        throw unavailable();
    }

    let url: URL;
    try {
        url = new URL(configured);
    } catch {
        throw unavailable();
    }

    const authority = configured
        .slice(configured.indexOf('://') + 3)
        .split('/')[0];
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        authority?.includes('@')
    ) {
        throw unavailable();
    }

    return url;
}

/**
 * Fail before account lookup or token creation when the canonical web URL is
 * unavailable. The first nonempty configured value is authoritative, including
 * an invalid value; legacy variables never override it.
 */
export function assertPasswordResetUrlConfigured(
    environment: PasswordResetUrlEnvironment = readCanonicalEnvironment()
): void {
    configuredPublicWebUrl(environment);
}

/**
 * Build a reset link from server configuration only, preserving its path prefix.
 * Resolve on every call so the mail callback independently rechecks preflight.
 */
export function buildCanonicalPasswordResetUrl(
    token: string,
    environment: PasswordResetUrlEnvironment = readCanonicalEnvironment()
): string {
    const base = configuredPublicWebUrl(environment);
    const url = new URL('reset-password', `${base.href.replace(/\/$/, '')}/`);
    url.searchParams.set('token', token);
    return url.toString();
}
