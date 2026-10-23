/** Explicit server-only inputs; do not serialize resolved credentials to clients or logs. */
export type SystemMailEnvironment = Readonly<
    Partial<
        Record<
            | 'VECTORIX_DEFAULT_RESEND_API_KEY'
            | 'VECTORIX_DEFAULT_RESEND_SENDER_EMAIL'
            | 'VECTORIX_DEFAULT_SMTP_HOST'
            | 'VECTORIX_DEFAULT_SMTP_PORT'
            | 'VECTORIX_DEFAULT_SMTP_USER'
            | 'VECTORIX_DEFAULT_SMTP_PASSWORD'
            | 'VECTORIX_DEFAULT_SMTP_SENDER_EMAIL',
            string
        >
    >
>;

export type SystemMailConfiguration =
    | Readonly<{
          provider: 'resend';
          apiKey: string;
          senderEmail: string;
      }>
    | Readonly<{
          provider: 'smtp';
          host: string;
          port: number;
          auth?: Readonly<{ user: string; pass: string }>;
          senderEmail: string;
      }>;

type SystemMailErrorCode =
    | 'SYSTEM_MAIL_NOT_CONFIGURED'
    | 'SYSTEM_MAIL_INVALID_CONFIGURATION'
    | 'SYSTEM_MAIL_DELIVERY_FAILED';

const errorMessages: Record<SystemMailErrorCode, string> = {
    SYSTEM_MAIL_NOT_CONFIGURED: 'System email provider is not configured.',
    SYSTEM_MAIL_INVALID_CONFIGURATION: 'System email configuration is invalid.',
    SYSTEM_MAIL_DELIVERY_FAILED: 'System email delivery failed.',
};

/** Static diagnostics deliberately retain neither provider errors nor their causes. */
export class SystemMailError extends Error {
    constructor(public readonly code: SystemMailErrorCode) {
        super(errorMessages[code]);
        this.name = 'SystemMailError';
    }
}

/** Explicit reads avoid weak ProcessEnv types in frontend server consumers. */
function readEnvironment(): SystemMailEnvironment {
    return {
        VECTORIX_DEFAULT_RESEND_API_KEY:
            process.env.VECTORIX_DEFAULT_RESEND_API_KEY,
        VECTORIX_DEFAULT_RESEND_SENDER_EMAIL:
            process.env.VECTORIX_DEFAULT_RESEND_SENDER_EMAIL,
        VECTORIX_DEFAULT_SMTP_HOST: process.env.VECTORIX_DEFAULT_SMTP_HOST,
        VECTORIX_DEFAULT_SMTP_PORT: process.env.VECTORIX_DEFAULT_SMTP_PORT,
        VECTORIX_DEFAULT_SMTP_USER: process.env.VECTORIX_DEFAULT_SMTP_USER,
        VECTORIX_DEFAULT_SMTP_PASSWORD:
            process.env.VECTORIX_DEFAULT_SMTP_PASSWORD,
        VECTORIX_DEFAULT_SMTP_SENDER_EMAIL:
            process.env.VECTORIX_DEFAULT_SMTP_SENDER_EMAIL,
    };
}

function invalid(): never {
    throw new SystemMailError('SYSTEM_MAIL_INVALID_CONFIGURATION');
}

function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0);
        if (code === undefined || code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

function sender(value: string | undefined): string {
    if (value && hasControlCharacters(value)) invalid();
    const normalized = value?.trim();
    return normalized && normalized.length > 0
        ? normalized
        : 'noreply@example.com';
}

function smtpAuthentication(environment: SystemMailEnvironment) {
    const user = environment.VECTORIX_DEFAULT_SMTP_USER;
    const pass = environment.VECTORIX_DEFAULT_SMTP_PASSWORD;
    const hasUser = user !== undefined && user !== '';
    const hasPassword = pass !== undefined && pass !== '';
    if (hasUser !== hasPassword || (hasUser && !user.trim())) invalid();
    return hasUser && hasPassword ? { user, pass } : undefined;
}

/**
 * Select one transport from current server configuration without performing I/O.
 * A nonempty Resend key is authoritative, including invalid selected values.
 * SMTP authentication is optional as a pair; secret bytes are never trimmed.
 */
export function resolveSystemMailConfiguration(
    environment: SystemMailEnvironment = readEnvironment()
): SystemMailConfiguration {
    const apiKey = environment.VECTORIX_DEFAULT_RESEND_API_KEY;
    if (apiKey !== undefined && apiKey !== '') {
        if (!apiKey.trim()) invalid();
        return {
            provider: 'resend',
            apiKey,
            senderEmail: sender(
                environment.VECTORIX_DEFAULT_RESEND_SENDER_EMAIL
            ),
        };
    }

    const host = environment.VECTORIX_DEFAULT_SMTP_HOST?.trim();
    if (!host) throw new SystemMailError('SYSTEM_MAIL_NOT_CONFIGURED');
    if (hasControlCharacters(host) || /[\s/\\?#@]/u.test(host)) invalid();

    const portText = environment.VECTORIX_DEFAULT_SMTP_PORT?.trim();
    if (portText && !/^\d+$/u.test(portText)) invalid();
    const port = portText ? Number(portText) : 587;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) invalid();
    const auth = smtpAuthentication(environment);

    return {
        provider: 'smtp',
        host,
        port,
        ...(auth ? { auth } : {}),
        senderEmail: sender(environment.VECTORIX_DEFAULT_SMTP_SENDER_EMAIL),
    };
}

/** Preflight static configuration only; this is not a provider connectivity or delivery check. */
export function assertSystemMailConfigured(
    environment?: SystemMailEnvironment
): void {
    resolveSystemMailConfiguration(environment);
}
