import { Buffer } from 'node:buffer';
import {
    EmbeddingError,
    type EmbeddingPreset,
    type ModelIdentity,
} from './types';

/** Titles are canonicalized once for deterministic document input, with a UTF-8-safe 200-byte ceiling. */
export function embeddingTitle(title?: string) {
    const normalized = title?.trim().replaceAll(/\s+/g, ' ');
    const value = normalized?.length ? normalized : 'none';
    let result = '';
    let bytes = 0;
    for (const char of value) {
        const size = Buffer.byteLength(char);
        if (bytes + size > 200) break;
        result += char;
        bytes += size;
    }
    return result;
}
function prefix(
    preset: EmbeddingPreset,
    kind: 'document' | 'query',
    title?: string
) {
    if (preset === 'GENERIC') return '';
    if (preset !== 'EMBEDDING_GEMMA')
        throw new EmbeddingError('INVALID_CONFIGURATION');
    return kind === 'query'
        ? 'task: search result | query: '
        : `title: ${embeddingTitle(title)} | text: `;
}
function preparationPrefix(preparation: string) {
    if (Buffer.byteLength(preparation) > 4096)
        throw new EmbeddingError('INPUT_TOO_LARGE');
    return preparation ? `${preparation}\n` : '';
}
/** Conservative one-UTF-8-byte-per-token cap leaves room for tokenizer special tokens. Native truncate:false remains authoritative. */
export function embeddingInputByteLimit(
    identity: Pick<ModelIdentity, 'contextTokens' | 'preset'>,
    options: {
        kind?: 'document' | 'query';
        title?: string;
        preparation?: string;
    } = {}
) {
    const fixed =
        preparationPrefix(options.preparation ?? '') +
        prefix(identity.preset, options.kind ?? 'document', options.title);
    const total = Math.min(identity.contextTokens - 32, 64 * 1024);
    const remaining = total - Buffer.byteLength(fixed);
    if (!Number.isInteger(total) || remaining < 1)
        throw new EmbeddingError('INPUT_TOO_LARGE');
    return remaining;
}
/** Explicit presets, never inferred from a model name. Preparation is a literal prefix shared by both input roles. */
export function prepareEmbeddingInput(
    identity: Pick<ModelIdentity, 'contextTokens' | 'preset'>,
    kind: 'document' | 'query',
    text: string,
    options: { title?: string; preparation?: string } = {}
) {
    if (
        !text.trim() ||
        Buffer.byteLength(text) >
            embeddingInputByteLimit(identity, { ...options, kind })
    )
        throw new EmbeddingError('INPUT_TOO_LARGE');
    return (
        preparationPrefix(options.preparation ?? '') +
        prefix(identity.preset, kind, options.title) +
        text
    );
}
