import type { SaxesTagNS } from 'saxes';
import type { StoryKind } from './docx-body';
import { word, WORD, invalid, attr } from './docx-xml';

export interface DocumentReferences {
    header: Set<string>;
    footer: Set<string>;
    footnote: Set<string>;
    endnote: Set<string>;
}
export function createDocumentReferences(): DocumentReferences {
    return {
        header: new Set(),
        footer: new Set(),
        footnote: new Set(),
        endnote: new Set(),
    };
}
const RELATIONSHIP_NAMESPACES = new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
function relationshipId(tag: SaxesTagNS) {
    const value = Object.values(tag.attributes).find(
        (attribute) =>
            attribute.local === 'id' &&
            RELATIONSHIP_NAMESPACES.has(attribute.uri)
    )?.value;
    if (!value || value.length > 200) throw invalid();
    return value;
}
/** Word note IDs are decimal integers; normalize their spelling before matching references and records. */
function noteId(tag: SaxesTagNS) {
    const value = Object.values(tag.attributes).find(
        (attribute) => attribute.local === 'id' && WORD.has(attribute.uri)
    )?.value;
    if (!value || value.length > 12 || !/^\+?\d+$/.test(value)) throw invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > 2_147_483_647)
        throw invalid();
    return String(number);
}
/** Only current, nondeleted XML calls this collector; relationship declarations alone never activate content. */
export function collectDocumentReference(
    tag: SaxesTagNS,
    role: StoryKind,
    inSectionProperties: boolean,
    inParagraph: boolean,
    references: DocumentReferences,
    sectionSlots: Set<string>
) {
    if (word(tag, 'headerReference') || word(tag, 'footerReference')) {
        if (
            role !== 'body' ||
            !inSectionProperties ||
            !['default', 'first', 'even'].includes(attr(tag, 'type') ?? '')
        )
            throw invalid();
        const slot = `${tag.local}:${attr(tag, 'type')}`;
        if (sectionSlots.has(slot)) throw invalid();
        sectionSlots.add(slot);
        references[word(tag, 'headerReference') ? 'header' : 'footer'].add(
            relationshipId(tag)
        );
    }
    if (word(tag, 'footnoteReference') || word(tag, 'endnoteReference')) {
        if (!inParagraph || role === 'footnote' || role === 'endnote')
            throw invalid();
        references[word(tag, 'footnoteReference') ? 'footnote' : 'endnote'].add(
            noteId(tag)
        );
    }
}
/** Parse only referenced normal notes. Duplicates and missing note records fail instead of returning partial text. */
export function skipUnreferencedNote(
    tag: SaxesTagNS,
    selected: ReadonlySet<string>,
    seen: Set<string>
) {
    const type = attr(tag, 'type');
    if (type && type !== 'normal') return true;
    const id = noteId(tag);
    if (seen.has(id)) throw invalid();
    seen.add(id);
    return !selected.has(id);
}
export function requireReferencedNotes(
    selected: ReadonlySet<string>,
    seen: ReadonlySet<string>
) {
    if ([...selected].some((id) => !seen.has(id))) throw invalid();
}
