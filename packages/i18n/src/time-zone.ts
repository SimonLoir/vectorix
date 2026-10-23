export const DEFAULT_VECTORIX_TIME_ZONE = 'Europe/Brussels';

/**
 * Validate a configured time zone with Intl and preserve the Brussels fallback.
 * Server callers resolve deployment values and pass only this public result to providers.
 */
export function resolveVectorixTimeZone(timeZone?: string) {
    const candidate = timeZone?.trim() ?? DEFAULT_VECTORIX_TIME_ZONE;
    try {
        new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0);
        return candidate;
    } catch {
        return DEFAULT_VECTORIX_TIME_ZONE;
    }
}
