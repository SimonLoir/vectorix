import { indexError } from './errors';

/** Select strongest child per exact candidate/parent before topK, without loading content or summing sibling ranks. */
export function selectSearchRepresentatives<T>(
    ranked: [string, T][],
    metadata: {
        id: string;
        parentId: string | null;
        indexedDocumentId: string;
    }[],
    parentEnabled: boolean,
    topK: number
) {
    const eligible = new Map(metadata.map((row) => [row.id, row]));
    const groups = new Set<string>();
    return ranked
        .filter(([id]) => {
            const chunk = eligible.get(id);
            if (!chunk) return false;
            if (!parentEnabled) return true;
            if (!chunk.parentId) throw indexError('SOURCE_UNAVAILABLE');
            const group = `${chunk.indexedDocumentId}:${chunk.parentId}`;
            if (groups.has(group)) return false;
            groups.add(group);
            return true;
        })
        .slice(0, topK);
}
