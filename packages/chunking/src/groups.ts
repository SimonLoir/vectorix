import type { StructuredExtraction } from '@repo/documents';
import type { StructureGroup } from './types';
import { trimRange } from './bytes';

/** Page, section and story boundaries are stronger than preferred minimum chunk size. */
export function structureGroups(
    artifact: StructuredExtraction
): StructureGroup[] {
    if (artifact.format === 'TEXT' || artifact.format === 'MARKDOWN')
        return textGroups(artifact);
    const groups: StructureGroup[] = [];
    let previousKey: string | undefined;
    for (const source of artifact.sources) {
        const range = trimRange(artifact.text, source.start, source.end);
        if (range.start === range.end) continue;
        const key =
            source.kind === 'pdf-page'
                ? `page:${source.index}`
                : `${source.partIndex ?? 1}:${source.section ?? 0}:${source.heading ?? ''}`;
        const previous = groups.at(-1);
        if (previous && key === previousKey) {
            previous.boundaries.push(previous.end);
            previous.end = range.end;
        } else
            groups.push({ ...range, heading: source.heading, boundaries: [] });
        previousKey = key;
    }
    return groups;
}

/** Recognize Markdown headings without rendering markup; text and citation offsets stay canonical. */
function textGroups(artifact: StructuredExtraction) {
    const groups: StructureGroup[] = [];
    let start = 0,
        heading: string | undefined;
    const add = (end: number) => {
        const range = trimRange(artifact.text, start, end);
        if (range.start < range.end)
            groups.push({ ...range, heading, boundaries: [] });
    };
    if (artifact.format === 'MARKDOWN') {
        for (const match of artifact.text.matchAll(/^#{1,6}[\t ]+(.+)$/gm)) {
            add(match.index);
            start = match.index;
            heading = match[1]!.trim().slice(0, 200);
        }
    }
    add(artifact.text.length);
    return groups;
}
