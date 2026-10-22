import type { PlannedChunk } from '@repo/chunking';
import { IndexingError } from './task-state';

/** Exhaust geometry before reservation while bounding duplicated overlap text and provenance in memory. */
export function collectIndexChunks(planner: Iterable<PlannedChunk>) {
    const chunks: PlannedChunk[] = [];
    let textBytes = 0,
        spanBytes = 0;
    for (const chunk of planner) {
        textBytes += Buffer.byteLength(chunk.text);
        spanBytes += Buffer.byteLength(JSON.stringify(chunk.sourceSpans));
        if (textBytes > 128 * 1024 ** 2 || spanBytes > 32 * 1024 ** 2)
            throw new IndexingError('CHUNK_LIMIT');
        chunks.push(chunk);
    }
    if (!chunks.length) throw new IndexingError('SOURCE_UNAVAILABLE');
    return chunks;
}
