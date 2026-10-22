import path from 'node:path';
import { invalid } from './docx-xml';
export const hasControlCharacters = (value: string) =>
    [...value].some(
        (character) =>
            character.codePointAt(0)! < 32 || character.codePointAt(0)! === 127
    );

/** Canonical package names reject ambiguous traversal and control characters before ZIP lookup. */
export function canonicalName(name: string) {
    if (
        !name ||
        name.length > 512 ||
        /[\\?#:%]/u.test(name) ||
        hasControlCharacters(name) ||
        name.startsWith('/') ||
        name.split('/').some((part) => part === '.' || part === '..')
    )
        throw invalid();
    return name.normalize('NFC').toLowerCase();
}

/** Relationship paths may climb out of a part directory, but never out of the ZIP package. */
export function resolveTarget(relationshipName: string, target: string) {
    let decoded: string;
    try {
        decoded = decodeURIComponent(target);
    } catch {
        throw invalid();
    }
    if (
        !decoded ||
        /[\\?#:]/u.test(decoded) ||
        hasControlCharacters(decoded) ||
        decoded.startsWith('//')
    )
        throw invalid();
    const owner =
        relationshipName === '_rels/.rels'
            ? ''
            : relationshipName
                  .replace(/(^|\/)_rels\//, '$1')
                  .replace(/\.rels$/, '');
    const resolved = path.posix.normalize(
        decoded.startsWith('/')
            ? decoded.slice(1)
            : path.posix.join(path.posix.dirname(owner), decoded)
    );
    if (resolved.startsWith('../') || resolved === '..') throw invalid();
    return canonicalName(resolved);
}
