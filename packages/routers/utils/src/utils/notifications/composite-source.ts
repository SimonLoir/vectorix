/** A bounded, unambiguous compound identity for durable account events. */
export function compositeSourceId(parts: readonly string[]) {
    return JSON.stringify(parts);
}
export function parseCompositeSourceId(
    value: string,
    length: number
): string[] | null {
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) &&
            parsed.length === length &&
            parsed.every((part) => typeof part === 'string' && part.length > 0)
            ? parsed
            : null;
    } catch {
        return null;
    }
}
