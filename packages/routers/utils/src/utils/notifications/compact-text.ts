/** Plain, bounded display text for notification titles and bodies. */
export function compactSubject(value: string | null | undefined) {
    const normalized = value
        ?.replaceAll(/<[^>]*>/g, ' ')
        .replaceAll(/[\p{Cc}]/gu, ' ')
        .replaceAll(/\s+/g, ' ')
        .replaceAll(/ ([.,])/g, '$1')
        .trim();
    return normalized ? normalized.slice(0, 100) : null;
}

export function compactMessage(value: string | null | undefined) {
    const normalized = value
        ?.replaceAll(/<[^>]*>/g, ' ')
        .replaceAll(/[\p{Cc}]/gu, ' ')
        .replaceAll(/\s+/g, ' ')
        .replaceAll(/ ([.,])/g, '$1')
        .trim();
    if (!normalized) return null;
    return normalized.length <= 500
        ? normalized
        : `${normalized.slice(0, 499)}…`;
}
