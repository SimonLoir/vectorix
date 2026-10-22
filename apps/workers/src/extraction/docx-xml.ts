import { SaxesParser, type SaxesTagNS } from 'saxes';
import { DocumentParserError, LIMITS } from './limits';
export const WORD = new Set([
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
export const word = (tag: SaxesTagNS, name: string) =>
    WORD.has(tag.uri) && tag.local === name;
export const attr = (tag: SaxesTagNS, name: string) =>
    Object.values(tag.attributes).find(
        (attribute) =>
            attribute.local === name &&
            (attribute.uri === '' || WORD.has(attribute.uri))
    )?.value;
export const invalid = () => new DocumentParserError('FILE_INVALID');
/** Strict namespace-aware XML with bounded nesting, tag/attribute sizes and no DTDs. */
export function parseXml(
    bytes: Buffer,
    callbacks: {
        open?: (tag: SaxesTagNS, depth: number) => void;
        close?: (tag: SaxesTagNS) => void;
        text?: (value: string) => void;
    }
) {
    let encoding = 'utf8';
    if (
        (bytes[0] === 0xff && bytes[1] === 0xfe) ||
        (bytes[0] === 0x3c && bytes[1] === 0)
    )
        encoding = 'utf-16le';
    else if (
        (bytes[0] === 0xfe && bytes[1] === 0xff) ||
        (bytes[0] === 0 && bytes[1] === 0x3c)
    )
        encoding = 'utf-16be';
    const parser = new SaxesParser({ xmlns: true });
    let depth = 0;
    parser.on('error', () => {
        throw invalid();
    });
    parser.on('doctype', () => {
        throw invalid();
    });
    parser.on('xmldecl', (declaration) => {
        if (
            declaration.encoding &&
            !/^(?:utf-8|utf-16|utf-16le|utf-16be)$/i.test(declaration.encoding)
        )
            throw invalid();
    });
    parser.on('opentag', (tag) => {
        if (
            ++depth > LIMITS.xmlDepth ||
            Object.keys(tag.attributes).length > LIMITS.xmlAttributes ||
            tag.name.length > 256
        )
            throw new DocumentParserError('PARSER_LIMIT');
        if (
            Object.values(tag.attributes).some(
                (attribute) =>
                    attribute.name.length > 256 || attribute.value.length > 8192
            )
        )
            throw new DocumentParserError('PARSER_LIMIT');
        callbacks.open?.(tag, depth);
    });
    parser.on('closetag', (tag) => {
        callbacks.close?.(tag);
        depth--;
    });
    parser.on('text', (value) => callbacks.text?.(value));
    parser.on('cdata', (value) => callbacks.text?.(value));
    const decoder = new TextDecoder(encoding, { fatal: true });
    try {
        for (let offset = 0; offset < bytes.length; offset += 16_384)
            parser.write(
                decoder.decode(bytes.subarray(offset, offset + 16_384), {
                    stream: true,
                })
            );
        parser.write(decoder.decode()).close();
    } catch (error) {
        if (error instanceof DocumentParserError) throw error;
        throw invalid();
    }
}
