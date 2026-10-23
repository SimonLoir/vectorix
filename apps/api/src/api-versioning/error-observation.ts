import { ORPCError, ValidationError } from '@orpc/server';
import type { Logger } from 'pino';

export type ApiErrorLogger = Pick<Logger, 'error'>;
export type ApiErrorMetadata = Readonly<{
    transport: 'RPC' | 'REST';
    major: number;
}>;

export const MAX_OUTPUT_VALIDATION_ISSUES = 1000;

type KnownApiError = Readonly<{
    error: ORPCError<string, unknown>;
    status: number;
}>;

/** Even instanceof can throw for revoked proxies; unknown values stay generic. */
function knownApiError(error: unknown): KnownApiError | undefined {
    try {
        if (error instanceof ORPCError) {
            const status = error.status;
            if (Number.isInteger(status)) return { error, status };
        }
    } catch {
        return;
    }
}

/** Only the framework's own bounded issue count may accompany the fixed kind. */
function outputIssueCount(
    known: KnownApiError | undefined
): number | undefined {
    if (!known || known.status < 500) return;
    try {
        const cause = Object.getOwnPropertyDescriptor(known.error, 'cause');
        if (
            !cause ||
            !('value' in cause) ||
            !(cause.value instanceof ValidationError)
        )
            return;
        const issues = Object.getOwnPropertyDescriptor(cause.value, 'issues');
        if (!issues || !('value' in issues) || !Array.isArray(issues.value))
            return;
        return Math.min(issues.value.length, MAX_OUTPUT_VALIDATION_ISSUES);
    } catch {
        return;
    }
}

/**
 * Log one bounded summary through this request's logger. Error payloads, names,
 * codes, causes, stacks and request-derived operation strings are never logged.
 * A failing logger cannot replace the original response or trigger raw fallback.
 */
export function observeApiError(
    error: unknown,
    logger: ApiErrorLogger,
    metadata: ApiErrorMetadata
): void {
    const known = knownApiError(error);
    if (known && known.status < 500) return;
    const issueCount = outputIssueCount(known);
    try {
        logger.error(
            {
                errorKind:
                    issueCount === undefined
                        ? 'UNEXPECTED'
                        : 'OUTPUT_VALIDATION',
                transport: metadata.transport,
                major: metadata.major,
                ...(issueCount === undefined ? {} : { issueCount }),
            },
            'API request failed'
        );
    } catch {
        // Logging is best effort and must never mask domain/transport semantics.
    }
}

/** Preserve explicit domain errors; hide raw failures and rejected output data. */
export function normalizeApiError(error: unknown): ORPCError<string, unknown> {
    const known = knownApiError(error);
    if (known && outputIssueCount(known) === undefined) return known.error;
    return new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'Internal server error',
    });
}
