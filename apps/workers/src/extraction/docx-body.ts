import {
    DocumentParserError,
    LIMITS,
    hasUsableText,
    type StructuredExtraction,
} from './limits';
import { WORD, word, attr, invalid, parseXml } from './docx-xml';
import {
    collectDocumentReference,
    skipUnreferencedNote,
    requireReferencedNotes,
    type DocumentReferences,
} from './docx-references';
export type StoryKind = 'body' | 'header' | 'footer' | 'footnote' | 'endnote';
const STORY_ROOTS: Record<StoryKind, string> = {
    body: 'document',
    header: 'hdr',
    footer: 'ftr',
    footnote: 'footnotes',
    endnote: 'endnotes',
};
export interface Style {
    heading: boolean;
    basedOn?: string;
}
/** Resolve current paragraph style outlines without following document relationships or historical changes. */
export function readStyles(bytes: Buffer) {
    const styles = new Map<string, Style>();
    let current: { id: string; style: Style } | undefined;
    parseXml(bytes, {
        open(tag) {
            if (word(tag, 'style')) {
                const id = attr(tag, 'styleId');
                if (id) {
                    if (styles.size >= 1000 || styles.has(id)) throw invalid();
                    current = {
                        id,
                        style: { heading: /^heading[1-9]$/i.test(id) },
                    };
                }
            } else if (current && word(tag, 'outlineLvl')) {
                const value = Number(attr(tag, 'val'));
                if (Number.isInteger(value) && value >= 0 && value < 9)
                    current.style.heading = true;
            } else if (current && word(tag, 'basedOn'))
                current.style.basedOn = attr(tag, 'val');
        },
        close(tag) {
            if (word(tag, 'style') && current) {
                styles.set(current.id, current.style);
                current = undefined;
            }
        },
    });
    return styles;
}
function isHeading(id: string | undefined, styles: Map<string, Style>) {
    const seen = new Set<string>();
    while (id) {
        if (seen.has(id) || seen.size > 32) throw invalid();
        if (/^heading[1-9]$/i.test(id)) return true;
        seen.add(id);
        const style = styles.get(id);
        if (!style) return false;
        if (style.heading) return true;
        id = style.basedOn;
    }
    return false;
}

/** Parse one visible Word story with local paragraph positions; only the main body assigns sections. */
export function extractBody(
    bytes: Buffer,
    styles: Map<string, Style>,
    role: StoryKind,
    partIndex: number,
    references: DocumentReferences,
    selectedNotes: ReadonlySet<string> = new Set()
): StructuredExtraction {
    const result: StructuredExtraction = {
        schemaVersion: 1,
        format: 'DOCX',
        text: '',
        sources: [],
        warnings: [],
    };
    let section = 1,
        paragraphNumber = 0,
        bodyDepth = 0,
        depth = 0,
        sectionPropertiesDepth = 0;
    const seenNoteIds = new Set<string>();
    const sectionSlots = new Set<string>();
    let deletedDepth = 0,
        textDepth = 0,
        instructionDepth = 0,
        historyDepth = 0,
        currentHeading: string | undefined;
    let paragraph:
        | {
              chunks: string[];
              bytes: number;
              section: number;
              number: number;
              heading: boolean;
              style?: string;
              endsSection: boolean;
          }
        | undefined;
    let outputBytes = 0,
        sawRoot = false,
        sawBody = false;
    const append = (value: string) => {
        if (!paragraph || deletedDepth || instructionDepth) return;
        paragraph.bytes += Buffer.byteLength(value, 'utf8');
        if (outputBytes + paragraph.bytes > LIMITS.textBytes)
            throw new DocumentParserError('PARSER_LIMIT');
        paragraph.chunks.push(value);
    };
    parseXml(bytes, {
        open(tag) {
            depth++;
            if (historyDepth) {
                historyDepth++;
                return;
            }
            if (
                WORD.has(tag.uri) &&
                /^(?:pPrChange|rPrChange|sectPrChange|tblPrChange|trPrChange|tcPrChange|numberingChange)$/.test(
                    tag.local
                )
            ) {
                historyDepth = 1;
                return;
            }
            if (
                tag.uri ===
                    'http://schemas.openxmlformats.org/markup-compatibility/2006' &&
                tag.local === 'AlternateContent'
            )
                throw invalid();
            if (depth === 1) {
                if (!word(tag, STORY_ROOTS[role])) throw invalid();
                sawRoot = true;
                if (role !== 'body') {
                    bodyDepth = 1;
                    sawBody = true;
                }
            }
            if (role === 'body' && word(tag, 'body')) {
                if (sawBody || depth !== 2) throw invalid();
                sawBody = true;
                bodyDepth = depth;
            }
            if (!bodyDepth) return;
            if (
                (role === 'footnote' && word(tag, 'footnote')) ||
                (role === 'endnote' && word(tag, 'endnote'))
            ) {
                if (depth !== 2) throw invalid();
                if (skipUnreferencedNote(tag, selectedNotes, seenNoteIds)) {
                    historyDepth = 1;
                    return;
                }
            }
            if (!deletedDepth && (word(tag, 'altChunk') || word(tag, 'subDoc')))
                throw invalid();
            if (word(tag, 'del') || word(tag, 'moveFrom')) deletedDepth++;
            if (word(tag, 'instrText') || word(tag, 'delInstrText'))
                instructionDepth++;
            if (!deletedDepth && !instructionDepth) {
                if (role === 'body' && word(tag, 'sectPr')) {
                    if (sectionPropertiesDepth) throw invalid();
                    sectionPropertiesDepth = depth;
                    sectionSlots.clear();
                }
                collectDocumentReference(
                    tag,
                    role,
                    sectionPropertiesDepth > 0 &&
                        depth === sectionPropertiesDepth + 1,
                    Boolean(paragraph),
                    references,
                    sectionSlots
                );
            }
            if (word(tag, 'p') && !deletedDepth) {
                // Text boxes create nested paragraphs; skip their text rather than merge source references.
                if (paragraph) throw invalid();
                if (++paragraphNumber > LIMITS.paragraphs)
                    throw new DocumentParserError('PARSER_LIMIT');
                paragraph = {
                    chunks: [],
                    bytes: 0,
                    section,
                    number: paragraphNumber,
                    heading: false,
                    endsSection: false,
                };
            }
            if (!paragraph || deletedDepth || instructionDepth) return;
            if (word(tag, 't')) textDepth++;
            else if (word(tag, 'tab')) append('\t');
            else if (word(tag, 'br') || word(tag, 'cr')) append('\n');
            else if (word(tag, 'noBreakHyphen')) append('\u2011');
            else if (word(tag, 'softHyphen')) append('\u00AD');
            else if (word(tag, 'pStyle')) paragraph.style = attr(tag, 'val');
            else if (word(tag, 'outlineLvl')) {
                const value = Number(attr(tag, 'val'));
                if (Number.isInteger(value) && value >= 0 && value < 9)
                    paragraph.heading = true;
            } else if (word(tag, 'sectPr')) paragraph.endsSection = true;
            else if (word(tag, 'altChunk') || word(tag, 'subDoc'))
                throw invalid();
        },
        close(tag) {
            if (historyDepth) {
                historyDepth--;
                depth--;
                return;
            }
            if (bodyDepth) {
                if (word(tag, 't') && !deletedDepth && !instructionDepth)
                    textDepth--;
                if (word(tag, 'p') && !deletedDepth && paragraph) {
                    const text = paragraph.chunks
                        .join('')
                        .replaceAll(/\r\n?/g, '\n');
                    if (result.sources.length > 0) {
                        result.text += '\n\n';
                        outputBytes += 2;
                    }
                    const start = result.text.length;
                    result.text += text;
                    outputBytes += Buffer.byteLength(text, 'utf8');
                    if (outputBytes > LIMITS.textBytes)
                        throw new DocumentParserError('PARSER_LIMIT');
                    if (
                        (paragraph.heading ||
                            isHeading(paragraph.style, styles)) &&
                        text.trim()
                    )
                        currentHeading = text.trim().slice(0, 200);
                    const index = result.sources.length;
                    result.sources.push({
                        kind: 'docx-paragraph',
                        index,
                        start,
                        end: result.text.length,
                        paragraph: paragraph.number,
                        ...(role === 'body'
                            ? { section: paragraph.section }
                            : {}),
                        part: role,
                        partIndex,
                        ...(currentHeading ? { heading: currentHeading } : {}),
                    });
                    if (!hasUsableText(text))
                        result.warnings.push({
                            code: 'NO_TEXT',
                            sourceIndex: index,
                        });
                    if (paragraph.endsSection) {
                        section++;
                        currentHeading = undefined;
                    }
                    paragraph = undefined;
                }
                if (word(tag, 'instrText') || word(tag, 'delInstrText'))
                    instructionDepth--;
                if (word(tag, 'del') || word(tag, 'moveFrom')) deletedDepth--;
                if (word(tag, 'sectPr') && sectionPropertiesDepth === depth)
                    sectionPropertiesDepth = 0;
                if (word(tag, 'body')) bodyDepth = 0;
            }
            depth--;
        },
        text(value) {
            if (textDepth > 0) append(value);
        },
    });
    if (!sawRoot || !sawBody) throw invalid();
    if (role === 'footnote' || role === 'endnote')
        requireReferencedNotes(selectedNotes, seenNoteIds);
    return result;
}
