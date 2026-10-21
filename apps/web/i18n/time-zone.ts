export const DEFAULT_VECTORIX_TIME_ZONE = 'Europe/Brussels';

export function resolveVectorixTimeZone(timeZone?: string) {
    const candidate = timeZone?.trim() ?? DEFAULT_VECTORIX_TIME_ZONE;
    try {
        new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0);
        return candidate;
    } catch {
        return DEFAULT_VECTORIX_TIME_ZONE;
    }
}
