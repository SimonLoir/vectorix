import { contentHash } from './storage';

export class TextExtractionError extends Error {
    constructor(
        readonly code:
            | 'TEXT_INVALID'
            | 'TEXT_EMPTY'
            | 'UPLOAD_INCOMPLETE'
            | 'ACCESS_REVOKED'
    ) {
        super(code);
    }
}
/** TXT and Markdown are decoded as strict UTF-8 and displayed as inert text, with normalized line endings. */
export function extractText(bytes: Uint8Array, expectedHash: string) {
    if (contentHash(bytes) !== expectedHash)
        throw new TextExtractionError('UPLOAD_INCOMPLETE');
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true })
            .decode(bytes)
            .replaceAll(/\r\n?/g, '\n');
    } catch {
        throw new TextExtractionError('TEXT_INVALID');
    }
    if (text.includes('\0')) throw new TextExtractionError('TEXT_INVALID');
    if (!text.trim()) throw new TextExtractionError('TEXT_EMPTY');
    return Buffer.from(text, 'utf8');
}
