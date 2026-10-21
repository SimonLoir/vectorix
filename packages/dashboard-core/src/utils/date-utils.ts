/**
 * Format a date to a relative time string (e.g., "in 2 days", "2 hours ago")
 * Using native JavaScript APIs
 */
export function formatDistanceToNow(date: Date): string {
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffSec = Math.floor(Math.abs(diffMs) / 1000);

    const isPast = diffMs < 0;
    const prefix = isPast ? '' : 'in ';
    const suffix = isPast ? 'ago' : '';

    const intervals = [
        { seconds: 31_536_000, label: 'year' },
        { seconds: 2_592_000, label: 'month' },
        { seconds: 604_800, label: 'week' },
        { seconds: 86_400, label: 'day' },
        { seconds: 3600, label: 'hour' },
        { seconds: 60, label: 'minute' },
    ];

    for (const interval of intervals) {
        const count = Math.floor(diffSec / interval.seconds);
        if (count > 0) {
            const plural = count > 1 ? 's' : '';
            return `${prefix}${count} ${interval.label}${plural} ${suffix}`.trim();
        }
    }

    return 'just now';
}

/**
 * Convert a date to a string suitable for <input type="datetime-local">
 * It takes the local time and formats it as YYYY-MM-DDThh:mm
 */
export function dateToDateTimeLocal(date: Date): string {
    const tzOffset = date.getTimezoneOffset() * 60_000;
    const localISOTime = new Date(date.getTime() - tzOffset).toISOString();
    return localISOTime.slice(0, 16);
}

/**
 * Create a new Date object from a datetime-local input value
 */
export function dateTimeLocalToDate(value: string): Date {
    return new Date(value);
}
