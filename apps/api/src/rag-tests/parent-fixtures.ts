import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import {
    createSemanticFixture,
    scanSemantic,
    type SemanticFixture,
} from './semantic-fixtures';

export const parentSizes = {
    targetTokens: 32,
    minTokens: 8,
    maxTokens: 64,
    overlapTokens: 8,
    semanticPercentile: 75,
    parentMaxTokens: 128,
};
export type ParentStrategy = 'DOCUMENT_STRUCTURE' | 'TOKEN_WINDOW' | 'SEMANTIC';

export function parentProfile(
    strategy: ParentStrategy = 'TOKEN_WINDOW',
    parentMaxTokens = parentSizes.parentMaxTokens
) {
    return {
        provider: 'OLLAMA' as const,
        model: 'fixture:latest',
        dimensions: 3,
        embeddingPreset: 'GENERIC' as const,
        chunkingStrategy: strategy,
        parentChild: true,
        chunking: { ...parentSizes, parentMaxTokens },
    };
}

export const parentText =
    'Les renards habitent la forêt française et protègent les arbres. ' +
    'Forest animals shelter near the river and the solar garden. ' +
    'Le café e\u0301 accompagne cette lecture et conserve les sources. ' +
    'Solar energy powers the garden while forest foxes explore. ' +
    'Les sources exactes gardent les passages et leur contexte. ' +
    'English context retains the final useful tail of the forest document.';

/** Fresh catalog membership/storage/provider bindings; teardown never fabricates physical cleanup. */
export async function createParentFixture(label: string, members = false) {
    const fixture = await createSemanticFixture(`Parent ${label}`, members);
    return {
        ...fixture,
        collection(
            name = label,
            strategy: ParentStrategy = 'TOKEN_WINDOW',
            parentMaxTokens = parentSizes.parentMaxTokens
        ) {
            return f.owner.rag.collections.create({
                name,
                grantCreatorRead: true,
                profile: parentProfile(strategy, parentMaxTokens),
            });
        },
    };
}

export const scanParent = scanSemantic;

/** SQL is necessary to inspect the separate dynamic vector tables, unavailable to the application Prisma schema. */
export async function vectorPublication(
    generationId: string,
    publicationId: string
) {
    const generation = await prisma.indexGeneration.findFirstOrThrow({
        where: { id: generationId, organizationId: f.org },
    });
    assert(
        new URL(process.env.VECTOR_DATABASE_URL!).pathname.endsWith('_test')
    );
    assert.match(generation.vectorSchema, /^[a-z_][a-z\d_]{0,62}$/u);
    assert.match(generation.tableName, /^g_[a-f\d]{32}$/u);
    const schema = `"${generation.vectorSchema}"`;
    const pool = new Pool({
        connectionString: process.env.VECTOR_DATABASE_URL,
    });
    try {
        const rows = await pool.query<{
            chunk_id: string;
            ordinal: number;
            chunk_hash: string;
        }>(
            `SELECT chunk_id,ordinal,chunk_hash FROM ${schema}."${generation.tableName}" WHERE publication_id=$1 ORDER BY ordinal`,
            [publicationId]
        );
        const ledger = await pool.query<{
            state: string;
            expected_count: number;
            manifest_hash: string;
        }>(
            `SELECT state,expected_count,manifest_hash FROM ${schema}.vx_publications WHERE generation_id=$1 AND id=$2`,
            [generationId, publicationId]
        );
        assert.equal(ledger.rows.length, 1);
        return { rows: rows.rows, ledger: ledger.rows[0]! };
    } finally {
        await pool.end();
    }
}

/** Compare real app and vector state: parents add context rows, never searchable chunks or manifest entries. */
export async function assertParentPublication(
    generationId: string,
    documentId: string,
    text: string
) {
    const candidate = await prisma.indexedDocument.findFirstOrThrow({
        where: {
            organizationId: f.org,
            generationId,
            documentId,
            status: 'PUBLISHED',
        },
    });
    const rows = await prisma.chunk.findMany({
        where: { organizationId: f.org, indexedDocumentId: candidate.id },
        orderBy: { ordinal: 'asc' },
    });
    const children = rows.filter((row) => row.kind === 'CHILD');
    const parents = rows.filter((row) => row.kind === 'PARENT');
    assert(children.length > 1);
    assert(parents.length > 0 && parents.length < children.length);
    assert.equal(candidate.chunkCount, children.length);
    assert.equal(candidate.materializedChunks, children.length);
    for (const [ordinal, child] of children.entries()) {
        assert.equal(child.ordinal, ordinal);
        assert.match(child.embeddingInputHash ?? '', /^[a-f\d]{64}$/u);
        assert(child.startOffset !== null && child.endOffset !== null);
        assert.equal(
            child.text,
            text.slice(child.startOffset, child.endOffset)
        );
        const parent = parents.find((row) => row.id === child.parentId);
        assert(
            parent && parent.startOffset !== null && parent.endOffset !== null
        );
        assert(parent.startOffset <= child.startOffset);
        assert(parent.endOffset >= child.endOffset);
        assert.equal(
            parent.text,
            text.slice(parent.startOffset, parent.endOffset)
        );
        assert.equal(parent.parentId, null);
        assert.equal(parent.embeddingInputHash, null);
    }
    assert.deepEqual(
        parents.map((row) => row.ordinal),
        parents.map((_, index) => children.length + index)
    );
    const vector = await vectorPublication(generationId, candidate.id);
    assert.equal(vector.ledger.state, 'SEALED');
    assert.equal(vector.ledger.expected_count, children.length);
    assert.deepEqual(
        vector.rows.map((row) => [row.chunk_id, row.ordinal, row.chunk_hash]),
        children.map((row) => [row.id, row.ordinal, row.textHash])
    );
    const manifest = createHash('sha256')
        .update(
            JSON.stringify(
                children.map((row) => [row.id, row.ordinal, row.textHash])
            )
        )
        .digest('hex');
    assert.equal(vector.ledger.manifest_hash, manifest);
    assert.equal(candidate.manifestHash, manifest);
    const accounting = await prisma.collectionIndexAccounting.findUniqueOrThrow(
        { where: { collectionId: candidate.collectionId } }
    );
    assert.equal(accounting.activeChunks, BigInt(children.length));
    assert.equal(accounting.retainedChunks, 0n);
    assert.equal(accounting.reservedChunks, 0n);
    return { candidate, children, parents };
}

/** Advance only accepted retirement deadlines in this disposable fixture; the real cleaner performs all state/accounting work. */
export async function cleanParentCollection(
    fixture: SemanticFixture,
    collectionId: string,
    generationIds: string[]
) {
    const collection = await f.owner.rag.collections.get({ id: collectionId });
    await f.owner.rag.collections.delete({
        id: collectionId,
        expectedRevision: collection.configurationRevision,
    });
    await fixture.scan(2);
    for (let pass = 0; pass < 15; pass++) {
        await prisma.documentSourceHold.updateMany({
            where: {
                organizationId: f.org,
                indexedDocument: { generationId: { in: generationIds } },
                state: 'RETIRED',
            },
            data: { retainUntil: new Date(0) },
        });
        await prisma.indexGeneration.updateMany({
            where: {
                organizationId: f.org,
                id: { in: generationIds },
                status: 'RETIRED',
            },
            data: { cleanupAfter: new Date(0) },
        });
        await prisma.indexTask.updateMany({
            where: {
                organizationId: f.org,
                generationId: { in: generationIds },
                kind: { in: ['CLEAN_GENERATION', 'CLEAN_PUBLICATION'] },
                status: 'PENDING',
            },
            data: { availableAt: new Date(0) },
        });
        await fixture.scan(1);
        if (
            (await prisma.indexGeneration.count({
                where: {
                    id: { in: generationIds },
                    status: { not: 'CLEANED' },
                },
            })) === 0
        )
            return;
    }
    assert.fail('Owned parent generation cleanup did not finish.');
}
