import type { VectorixApiV1Outputs } from '@repo/api';

export type ActivitySummary =
    VectorixApiV1Outputs['admin']['rag']['telemetry']['summary'];
export type ActivityCounters = NonNullable<ActivitySummary['totals']>;
export type ActivityDimension = ActivitySummary['dimensions'][number];
export type ActivityWindow = '24H' | '7D' | '30D';
export type ActivityText = (
    key: string,
    values?: Record<string, string | number>
) => string;
export type ActivityFormatting = Readonly<{
    locale: string;
    text: ActivityText;
    date: (value: Date) => string;
}>;

export const activityWindows: readonly ActivityWindow[] = ['24H', '7D', '30D'];
export const executionCounters = [
    'recordedStarts',
    'recordedSuccesses',
    'recordedFailures',
    'recordedContinuations',
    'recordedSupersessions',
    'recordedDenials',
] as const;
export const nativeCounters = [
    'nativeStarts',
    'nativeValidatedBatches',
    'nativeFailedBatches',
    'validatedVectors',
    'dispatchedPreparedBytes',
    'validatedPreparedBytes',
    'validatedEstimatedInputTokens',
    'knownProviderInputTokens',
    'unknownProviderTokenBatches',
    'knownBilledInputTokens',
    'unknownBilledTokenBatches',
] as const;

/** Integer strings are formatted as BIGINT; only the contract's Float uses Number. */
export function activityNumber(value: string | number, locale: string): string {
    return new Intl.NumberFormat(locale, {
        maximumSignificantDigits: typeof value === 'number' ? 15 : undefined,
    }).format(typeof value === 'string' ? BigInt(value) : value);
}
