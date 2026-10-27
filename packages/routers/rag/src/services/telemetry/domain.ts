import type { CredentialProvider, ChunkingStrategy } from '@repo/db';
import type {
    TelemetryExecution,
    TelemetryFailure,
    TelemetryPhase,
    TelemetryTags,
} from './types';

/** Only saved executing native providers/strategies have an observational workload. */
export function indexTelemetryTags(
    organizationId: string,
    profile: {
        provider: CredentialProvider;
        chunkingStrategy: ChunkingStrategy;
    }
): TelemetryTags | null {
    if (profile.provider === 'S3' || profile.provider === 'TEI') return null;
    return {
        organizationId,
        provider: profile.provider,
        workload:
            profile.chunkingStrategy === 'DOCUMENT_STRUCTURE'
                ? 'INDEX_STRUCTURE'
                : profile.chunkingStrategy === 'TOKEN_WINDOW'
                  ? 'INDEX_TOKEN'
                  : 'INDEX_SEMANTIC',
    };
}

/** Whitelist classification only: unknown codes/messages/bodies never become a metric label. */
export function telemetryFailure(code: unknown): TelemetryFailure {
    if (typeof code !== 'string') return 'OTHER';
    if (['ACCESS_REVOKED', 'FORBIDDEN', 'UNAUTHORIZED'].includes(code))
        return 'ACCESS';
    if (['LEASE_LOST'].includes(code)) return 'LEASE';
    if (
        [
            'PROFILE_UNSUPPORTED',
            'MODEL_CHANGED',
            'MODEL_NOT_FOUND',
            'MODEL_UNSUPPORTED',
            'DIMENSIONS_UNSUPPORTED',
        ].includes(code)
    )
        return 'PROFILE';
    if (['CREDENTIALS_INVALID', 'INVALID_CONFIGURATION'].includes(code))
        return 'CREDENTIALS';
    if (
        [
            'PROVIDER_REJECTED',
            'PROVIDER_TIMEOUT',
            'PROVIDER_UNAVAILABLE',
            'INVALID_PROVIDER_RESPONSE',
        ].includes(code)
    )
        return 'PROVIDER';
    if (code === 'STORAGE_UNAVAILABLE') return 'STORAGE';
    if (
        [
            'SOURCE_UNAVAILABLE',
            'UPLOAD_INCOMPLETE',
            'PARSER_INVALID',
            'INVALID_UTF8',
            'EMPTY_DOCUMENT',
        ].includes(code)
    )
        return 'SOURCE';
    if (['VECTOR_UNAVAILABLE', 'VECTOR_BINDING_CHANGED'].includes(code))
        return 'VECTOR';
    if (['QUOTA_EXCEEDED', 'CHUNK_LIMIT'].includes(code)) return 'QUOTA';
    if (['INPUT_TOO_LARGE', 'PARSER_LIMIT'].includes(code)) return 'INPUT';
    return code === 'PROCESSING_FAILED' ? 'PROCESSING' : 'OTHER';
}

/** Preserve the original operation result/exception whether recording is enabled or not. */
export function measureTelemetry<T>(
    execution: TelemetryExecution | undefined,
    phase: TelemetryPhase,
    operation: () => Promise<T>
) {
    return execution ? execution.measure(phase, operation) : operation();
}

/** Pure planning stays synchronous; observation adds no extra async scheduling boundary. */
export function measureSyncTelemetry<T>(
    execution: TelemetryExecution | undefined,
    phase: TelemetryPhase,
    operation: () => T
) {
    const close = execution?.phase(phase);
    try {
        return operation();
    } finally {
        close?.();
    }
}
