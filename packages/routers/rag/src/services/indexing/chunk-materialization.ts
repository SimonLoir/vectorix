import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Chunk, IndexTask, PrismaClient } from '@repo/db';
import type { ParentContextLayout, PlannedChunk } from '@repo/chunking';
import { prepareEmbeddingInput, type ModelIdentity } from '@repo/embeddings';
import { manifestHash } from '@repo/vector-store';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { contentHash } from '../documents/storage';
import { accountMaterializedChunks } from './accounting';
import { requireCurrentCandidate } from './publication-state';
import {
    IndexingError,
    renewIndexClaim,
    requireIndexAuthority,
    type IndexClaim,
} from './task-state';

interface MaterializationInput {
    claim: IndexClaim;
    task: IndexTask;
    candidateId: string;
    language: Chunk['language'];
    fileName: string;
    preparation: string;
    identity: ModelIdentity;
    children: PlannedChunk[];
    layout?: ParentContextLayout;
}

function expectedRows(
    input: MaterializationInput,
    existing: { id: string; ordinal: number }[]
) {
    const ids = new Map(existing.map((row) => [row.ordinal, row.id]));
    const plans = [...(input.layout?.parents ?? []), ...input.children];
    for (const plan of plans)
        if (!ids.has(plan.ordinal)) ids.set(plan.ordinal, randomUUID());
    return plans.map((plan) => {
        const child = plan.ordinal < input.children.length;
        const parentOrdinal = input.layout?.childParentOrdinals[plan.ordinal];
        return {
            id: ids.get(plan.ordinal)!,
            organizationId: input.claim.organizationId,
            generationId: input.claim.generationId,
            indexedDocumentId: input.candidateId,
            ordinal: plan.ordinal,
            kind: child ? ('CHILD' as const) : ('PARENT' as const),
            parentId: child && input.layout ? ids.get(parentOrdinal!)! : null,
            text: plan.text,
            textHash: contentHash(plan.text),
            embeddingInputHash: child
                ? contentHash(
                      prepareEmbeddingInput(
                          input.identity,
                          'document',
                          plan.text,
                          {
                              title: input.fileName,
                              preparation: input.preparation,
                          }
                      )
                  )
                : null,
            startOffset: plan.start,
            endOffset: plan.end,
            sourceSpans: plan.sourceSpans.map((span) => ({
                source: { ...span.source },
                start: span.start,
                end: span.end,
            })),
            language: input.language,
            tokenCount: plan.tokenCount,
            tokenCountIsEstimate: true,
        };
    });
}

type ExpectedRow = ReturnType<typeof expectedRows>[number];
type LayoutMetadata = Pick<
    Chunk,
    | 'id'
    | 'ordinal'
    | 'kind'
    | 'parentId'
    | 'textHash'
    | 'embeddingInputHash'
    | 'startOffset'
    | 'endOffset'
>;

function metadataMatches(
    row: LayoutMetadata,
    expected: ExpectedRow,
    parentEnabled: boolean
) {
    const historicalRange =
        !parentEnabled && row.startOffset === null && row.endOffset === null;
    return (
        row.id === expected.id &&
        row.ordinal === expected.ordinal &&
        row.kind === expected.kind &&
        row.parentId === expected.parentId &&
        row.textHash === expected.textHash &&
        row.embeddingInputHash === expected.embeddingInputHash &&
        (historicalRange ||
            (row.startOffset === expected.startOffset &&
                row.endOffset === expected.endOffset))
    );
}

function rowMatches(row: Chunk, expected: ExpectedRow, parentEnabled: boolean) {
    return (
        metadataMatches(row, expected, parentEnabled) &&
        row.text === expected.text &&
        row.language === expected.language &&
        row.tokenCount === expected.tokenCount &&
        row.tokenCountIsEstimate === expected.tokenCountIsEstimate &&
        isDeepStrictEqual(row.sourceSpans, expected.sourceSpans)
    );
}

/**
 * Insert parents before linked children, adopting only exact canonical retries.
 * Parent-enabled rows are immutable from insertion in SQL; only searchable
 * children advance accounting. Every batch rechecks the exact claim and actor.
 */
export async function materializeIndexChunks(
    db: PrismaClient,
    input: MaterializationInput
) {
    const scope = {
        organizationId: input.claim.organizationId,
        generationId: input.claim.generationId,
        indexedDocumentId: input.candidateId,
    };
    const existing = await db.chunk.findMany({
        where: scope,
        select: { id: true, ordinal: true },
        take: 200_001,
    });
    const rows = expectedRows(input, existing);
    const expected = new Map(rows.map((row) => [row.ordinal, row]));
    if (existing.some((row) => !expected.has(row.ordinal)))
        throw new IndexingError('PROCESSING_FAILED');
    const phases = input.layout
        ? [
              rows.filter((row) => row.kind === 'PARENT'),
              rows.filter((row) => row.kind === 'CHILD'),
          ]
        : [rows];
    for (const phase of phases)
        for (let start = 0; start < phase.length; start += 128)
            await materializeBatch(db, input, phase.slice(start, start + 128));
    const children = rows
        .filter((row) => row.kind === 'CHILD')
        .toSorted((left, right) => left.ordinal - right.ordinal);
    const hash = manifestHash(
        children.map((row) => ({
            chunkId: row.id,
            ordinal: row.ordinal,
            chunkHash: row.textHash,
        }))
    );
    if (input.layout) await sealParentLayout(db, input, rows, hash);
    return {
        chunks: children.map(({ id, ordinal, textHash }) => ({
            id,
            ordinal,
            textHash,
        })),
        hash,
    };
}

/** Each committed batch contains one kind, so parent rows can be adopted after a partial child failure. */
async function materializeBatch(
    db: PrismaClient,
    input: MaterializationInput,
    batch: ExpectedRow[]
) {
    const expected = new Map(batch.map((row) => [row.ordinal, row]));
    await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, input.claim, 'MATERIALIZING');
        await requireIndexAuthority(tx, input.task);
        const { candidate } = await requireCurrentCandidate(
            tx,
            input.claim,
            input.candidateId
        );
        const present = await tx.chunk.findMany({
            where: {
                organizationId: input.claim.organizationId,
                generationId: input.claim.generationId,
                indexedDocumentId: input.candidateId,
                ordinal: { in: batch.map((row) => row.ordinal) },
            },
        });
        for (const row of present)
            if (!rowMatches(row, expected.get(row.ordinal)!, !!input.layout))
                throw new IndexingError('PROCESSING_FAILED');
        const ordinals = new Set(present.map((row) => row.ordinal));
        const missing = batch.filter((row) => !ordinals.has(row.ordinal));
        if (!missing.length) return;
        if (input.layout && candidate.status !== 'STAGING')
            throw new IndexingError('PROCESSING_FAILED');
        await tx.chunk.createMany({ data: missing });
        const childCount = missing.filter((row) => row.kind === 'CHILD').length;
        if (childCount)
            await accountMaterializedChunks(tx, {
                collectionId: input.claim.collectionId,
                candidateId: input.candidateId,
                taskId: input.task.id,
                count: childCount,
            });
    });
}

/**
 * A real candidate write fences the serializable snapshot against statement-level
 * chunk owner touches. Canonical content was verified per batch and is SQL-immutable
 * from insertion; this final bounded identity/layout check precedes external vectors.
 */
async function sealParentLayout(
    db: PrismaClient,
    input: MaterializationInput,
    expected: ExpectedRow[],
    hash: string
) {
    await runSerializableTransaction(
        db,
        async (tx) => {
            await renewIndexClaim(tx, input.claim, 'SEALING_LAYOUT');
            await requireIndexAuthority(tx, input.task);
            await requireCurrentCandidate(tx, input.claim, input.candidateId);
            const candidate = await tx.indexedDocument.update({
                where: { id: input.candidateId },
                data: { updatedAt: new Date() },
            });
            const rows = await tx.chunk.findMany({
                where: {
                    organizationId: input.claim.organizationId,
                    generationId: input.claim.generationId,
                    indexedDocumentId: input.candidateId,
                },
                select: {
                    id: true,
                    ordinal: true,
                    kind: true,
                    parentId: true,
                    textHash: true,
                    embeddingInputHash: true,
                    startOffset: true,
                    endOffset: true,
                },
                orderBy: { ordinal: 'asc' },
                take: 200_001,
            });
            const ordered = expected.toSorted(
                (left, right) => left.ordinal - right.ordinal
            );
            if (
                rows.length !== ordered.length ||
                rows.some(
                    (row, index) => !metadataMatches(row, ordered[index]!, true)
                ) ||
                candidate.chunkCount !== input.children.length ||
                candidate.materializedChunks !== input.children.length
            )
                throw new IndexingError('PROCESSING_FAILED');
            if (candidate.status === 'STAGING')
                await tx.indexedDocument.update({
                    where: { id: candidate.id },
                    data: { status: 'SEALED', manifestHash: hash },
                });
            else if (
                !['SEALED', 'PUBLISHED'].includes(candidate.status) ||
                candidate.manifestHash !== hash
            )
                throw new IndexingError('PROCESSING_FAILED');
        },
        { timeout: 30_000 }
    );
}
