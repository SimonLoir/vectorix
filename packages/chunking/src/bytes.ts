/** Largest UTF-16 offset under a UTF-8 byte budget, never splitting a surrogate pair. */
export function cutForward(
    text: string,
    start: number,
    end: number,
    budget: number
) {
    let low = start,
        high = Math.min(end, start + budget);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(start, middle), 'utf8') <= budget)
            low = middle;
        else high = middle - 1;
    }
    if (low < end && low > start && /[\uD800-\uDBFF]/u.test(text[low - 1]!))
        low--;
    return low;
}
/** Earliest safe offset within the suffix budget; overlap is bounded independently of the input size. */
export function cutBackward(
    text: string,
    start: number,
    end: number,
    budget: number
) {
    let low = Math.max(start, end - budget),
        high = end;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Buffer.byteLength(text.slice(middle, end), 'utf8') <= budget)
            high = middle;
        else low = middle + 1;
    }
    if (low < end && /[\uDC00-\uDFFF]/u.test(text[low]!)) low++;
    return low;
}
export function trimRange(text: string, start: number, end: number) {
    while (start < end && /\s/u.test(text[start]!)) start++;
    while (end > start && /\s/u.test(text[end - 1]!)) end--;
    return { start, end };
}
