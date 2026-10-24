import type { ParserErrorCode } from './limits';

const XREF_RECONSTRUCTION =
    /^Internal Error: xref num ([1-9]\d{0,9}) not found but needed, try to reconstruct$/u;
const MAX_XREF_OBJECT_ID = 2_147_483_647;
// Linearization describes optional fast-web-view hints, not page content. Native
// fixtures verify complete sequential extraction for this exact diagnostic.
const INVALID_LINEARIZATION_LENGTH =
    'Syntax Warning: Length in linearization table is invalid';

function isXrefReconstruction(line: string): boolean {
    const match = XREF_RECONSTRUCTION.exec(line);
    return Boolean(match && Number(match[1]) <= MAX_XREF_OBJECT_ID);
}

/**
 * Classify bounded native diagnostics without exposing their text. A successful
 * exit permits only proven whole-line xref reconstruction and invalid optional
 * linearization-length diagnostics. Xref object IDs remain positive and bounded.
 * All other nonblank diagnostics fail closed,
 * including historically tolerated unclassified chatter. This is not a general
 * PDF repair policy: mixed reconstruction/content errors remain invalid.
 * Captured timeout/output-limit failures take precedence in runPoppler itself.
 */
export function classifyPopplerResult({
    code,
    signal,
    stderr,
}: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
}>): ParserErrorCode | null {
    if (signal) return 'PARSER_LIMIT';
    // The native wrapper identifies launcher failures. A PDF diagnostic merely
    // containing "not found" does not establish missing parser infrastructure.
    if (code === 126 || code === 127 || /^prlimit:/mu.test(stderr))
        return 'PARSER_UNAVAILABLE';
    if (code !== 0)
        return /incorrect password|password required|encrypted/iu.test(stderr)
            ? 'PDF_ENCRYPTED'
            : 'FILE_INVALID';
    const lines = stderr.split(/\r?\n/u);
    return lines.every(
        (line) =>
            line.trim() === '' ||
            line === INVALID_LINEARIZATION_LENGTH ||
            isXrefReconstruction(line)
    )
        ? null
        : 'FILE_INVALID';
}
