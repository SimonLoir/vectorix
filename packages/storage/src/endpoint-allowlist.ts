/** One operator setting that contributes approved outbound destinations. */
export type EndpointAllowlistSource = Readonly<{
    /** Environment variable name, used only in sanitized warnings. */
    name: string;
    value: string | undefined;
    /** Comma-separated list rather than a single URL. */
    list?: boolean;
}>;

type Normalize = (value: string) => string;

const parsed = new Map<string, ReadonlySet<string>>();

function addSource(
    allowed: Set<string>,
    scope: string,
    { name, value, list }: EndpointAllowlistSource,
    normalize: Normalize
) {
    const entries = list ? (value ?? '').split(',') : [value ?? ''];
    for (const [index, entry] of entries.entries()) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        try {
            allowed.add(normalize(trimmed));
        } catch {
            console.warn(
                list
                    ? `[${scope}] Ignoring invalid ${name} entry at position ${index + 1}.`
                    : `[${scope}] Ignoring invalid ${name} value.`
            );
        }
    }
}

/**
 * Normalize every configured entry independently. A malformed entry is skipped
 * with one sanitized warning naming its variable and 1-based position, never
 * its value, so it cannot hide later valid entries. Results are cached per
 * distinct configuration, so changing environment values (tests, reloads) is
 * honored without reparsing on every request.
 */
export function parseEndpointAllowlist(
    scope: string,
    sources: readonly EndpointAllowlistSource[],
    normalize: Normalize
): ReadonlySet<string> {
    const key = JSON.stringify([
        scope,
        sources.map(({ name, value, list }) => [name, value ?? null, !!list]),
    ]);
    const cached = parsed.get(key);
    if (cached) return cached;
    const allowed = new Set<string>();
    for (const source of sources) addSource(allowed, scope, source, normalize);
    parsed.set(key, allowed);
    return allowed;
}

/** Exact match after normalization; an unparsable candidate is never allowed. */
export function isAllowedEndpoint(
    endpoint: string,
    allowed: ReadonlySet<string>,
    normalize: Normalize
): boolean {
    try {
        return allowed.has(normalize(endpoint));
    } catch {
        return false;
    }
}
