import type { Entry, ZipFile } from 'yauzl';
import {
    DocumentParserError,
    LIMITS,
    type StructuredExtraction,
} from './limits';
import { invalid } from './docx-xml';
import { readPart, type XmlBudget } from './docx-archive';
import { extractBody, type Style, type StoryKind } from './docx-body';
import type { DocumentReferences } from './docx-references';

interface StoryRelationship {
    id: string;
    target: string;
    role: StoryKind;
}
/** Only live section references select headers/footers; notes are selected after those stories expose their own live references. */
export async function appendReferencedStories(input: {
    zip: ZipFile;
    entries: Map<string, Entry>;
    budget: XmlBudget;
    styles: Map<string, Style>;
    stories: StoryRelationship[];
    references: DocumentReferences;
    result: StructuredExtraction;
}) {
    const { zip, entries, budget, styles, stories, references, result } = input;
    const parts = new Map<string, StructuredExtraction>();
    let textBytes = Buffer.byteLength(result.text, 'utf8'),
        sourceCount = result.sources.length;
    const retain = (name: string, addition: StructuredExtraction) => {
        sourceCount += addition.sources.length;
        textBytes +=
            Buffer.byteLength(addition.text, 'utf8') +
            (addition.sources.length && sourceCount > addition.sources.length
                ? 2
                : 0);
        if (sourceCount > LIMITS.paragraphs || textBytes > LIMITS.textBytes)
            throw new DocumentParserError('PARSER_LIMIT');
        parts.set(name, addition);
    };
    const selected = new Map<string, StoryKind>();
    for (const role of ['header', 'footer'] as const) {
        for (const id of references[role]) {
            const relationship = stories.find(
                (story) => story.id === id && story.role === role
            );
            if (!relationship) throw invalid();
            selected.set(relationship.target, role);
        }
    }
    for (const [name, role] of selected) {
        retain(
            name,
            extractBody(
                await readPart(
                    zip,
                    entries.get(name)!,
                    LIMITS.mainXmlBytes,
                    budget
                ),
                styles,
                role,
                1,
                references
            )
        );
    }
    for (const role of ['footnote', 'endnote'] as const) {
        const matches = stories.filter((story) => story.role === role);
        if (matches.length > 1) throw invalid();
        if (!references[role].size) continue;
        const relationship = matches[0];
        if (!relationship) throw invalid();
        retain(
            relationship.target,
            extractBody(
                await readPart(
                    zip,
                    entries.get(relationship.target)!,
                    LIMITS.mainXmlBytes,
                    budget
                ),
                styles,
                role,
                1,
                references,
                references[role]
            )
        );
    }
    let partIndex = 1;
    for (const [, addition] of [...parts].toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
    )) {
        partIndex++;
        if (!addition.sources.length) continue;
        const separator = result.sources.length ? '\n\n' : '';
        const offset = result.text.length + separator.length,
            firstIndex = result.sources.length;
        result.text += separator + addition.text;
        result.sources.push(
            ...addition.sources.map((source) => ({
                ...source,
                partIndex,
                index: source.index + firstIndex,
                start: source.start + offset,
                end: source.end + offset,
            }))
        );
        result.warnings.push(
            ...addition.warnings.map((warning) => ({
                ...warning,
                sourceIndex: warning.sourceIndex + firstIndex,
            }))
        );
    }
}
