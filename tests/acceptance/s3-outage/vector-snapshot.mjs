/** Bounded READ ONLY app/vector readers; imported modules perform no I/O. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, RecipeError } from './private.mjs';
import { failure, canonical } from './vector-observation.mjs';
import { sha, id } from './vector-workflow.mjs';
const same = (a, b) => canonical(a) === canonical(b);
/** Queries exclude secrets/lease tokens and slice JSON source spans inside PostgreSQL. */
export async function readVectorSnapshot(tx, fixture, binding) {
    const org = fixture.organization.id,
        generations = [binding.g1, ...(binding.g2 ? [binding.g2] : [])];
    failure(
        id(org) &&
            generations.every(id) &&
            generations.length <= 2 &&
            id(binding.collectionId) &&
            id(binding.documentId) &&
            id(binding.versionId),
        'QUERY_SCOPE'
    );
    const models = {
        users: 'user',
        organizations: 'organization',
        members: 'member',
        documents: 'document',
        versions: 'documentVersion',
        extractions: 'documentExtraction',
        collections: 'collection',
        keys: 'apikey',
        groups: 'organizationGroup',
        invitations: 'invitation',
        credentials: 'credentials',
        selections: 'credentialSelection',
        sessions: 'session',
    };
    const counts = Object.fromEntries(
        await Promise.all(
            Object.entries(models).map(async ([name, model]) => [
                name,
                await tx[model].count(),
            ])
        )
    );
    const collection = await tx.collection.findFirst({
        where: { id: binding.collectionId, organizationId: org },
        select: {
            id: true,
            organizationId: true,
            activeGenerationId: true,
            configurationRevision: true,
            contentSequence: true,
            deletedAt: true,
        },
    });
    const generationRows = await tx.indexGeneration.findMany({
        where: { organizationId: org, collectionId: binding.collectionId },
        orderBy: { id: 'asc' },
        take: 3,
        select: {
            id: true,
            organizationId: true,
            collectionId: true,
            status: true,
            previousGenerationId: true,
            activatedAt: true,
            retiredAt: true,
            cleanupAfter: true,
            configurationRevision: true,
            destinationFingerprint: true,
            modelIdentity: true,
            capabilitySnapshot: true,
            tableName: true,
            vectorSchema: true,
            projectedChunks: true,
            appliedSequence: true,
            chunkerVersion: true,
            parentContextVersion: true,
            configuration: true,
        },
    });
    const candidates = await tx.indexedDocument.findMany({
        where: { organizationId: org, collectionId: binding.collectionId },
        orderBy: { id: 'asc' },
        take: 3,
        select: {
            id: true,
            generationId: true,
            documentId: true,
            sourceVersionId: true,
            extractionId: true,
            status: true,
            chunkCount: true,
            materializedChunks: true,
            manifestHash: true,
            vectorSealedAt: true,
            publishedAt: true,
        },
    });
    const tasks = await tx.indexTask.findMany({
        where: { organizationId: org, collectionId: binding.collectionId },
        orderBy: { id: 'asc' },
        take: 6,
        select: {
            id: true,
            generationId: true,
            indexedDocumentId: true,
            kind: true,
            status: true,
            stage: true,
            attempts: true,
            leaseEpoch: true,
            reservedChunks: true,
            completedChunks: true,
            errorCode: true,
            availableAt: true,
            updatedAt: true,
            leasedUntil: true,
            completedAt: true,
        },
    });
    const chunks = await tx.$queryRawUnsafe(
        `SELECT id,"generationId","indexedDocumentId",ordinal,kind,"parentId","textHash","embeddingInputHash","startOffset","endOffset",CASE WHEN octet_length(text)<=4096 THEN text END AS text,jsonb_array_length("sourceSpans") AS "sourceSpanCount",(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM (SELECT value,ord FROM jsonb_array_elements("sourceSpans") WITH ORDINALITY v(value,ord) ORDER BY ord LIMIT 64) bounded) AS "sourceSpans" FROM "Chunk" WHERE "organizationId"=$1 AND "generationId"=ANY($2::text[]) ORDER BY "generationId",ordinal LIMIT 33`,
        org,
        generations
    );
    const desired = await tx.generationDocument.findMany({
        where: { organizationId: org, collectionId: binding.collectionId },
        take: 3,
        select: {
            generationId: true,
            documentId: true,
            desiredVersionId: true,
            desiredExtractionId: true,
            publishedIndexedDocumentId: true,
            removedAt: true,
            lastErrorCode: true,
        },
    });
    const holds = await tx.documentSourceHold.findMany({
        where: { organizationId: org },
        take: 3,
        select: {
            indexedDocumentId: true,
            versionId: true,
            state: true,
            retainUntil: true,
            releasedAt: true,
        },
    });
    const originals = await tx.documentVersion.aggregate({
            where: { organizationId: org, discardedAt: null },
            _sum: { byteSize: true },
        }),
        extractions = await tx.documentExtraction.aggregate({
            where: { organizationId: org, discardedAt: null },
            _sum: { byteSize: true },
        }),
        reservations = await tx.documentIngestion.aggregate({
            where: { organizationId: org },
            _sum: { reservedBytes: true },
        });
    return {
        quota: {
            originalBytes: String(originals._sum.byteSize ?? 0n),
            extractionBytes: String(extractions._sum.byteSize ?? 0n),
            reservedBytes: String(reservations._sum.reservedBytes ?? 0n),
        },
        observedAt: new Date(),
        counts,
        collection,
        generations: generationRows,
        candidates,
        tasks,
        chunks,
        desired,
        holds,
        user: await tx.user.findUnique({
            where: { id: fixture.users.owner.userId },
            select: {
                id: true,
                email: true,
                emailVerified: true,
                isSuperAdmin: true,
            },
        }),
        organization: await tx.organization.findUnique({
            where: { id: org },
            select: { id: true, isActive: true },
        }),
        members: await tx.member.findMany({
            where: { organizationId: org },
            take: 2,
            select: {
                id: true,
                organizationId: true,
                userId: true,
                role: true,
                createdAt: true,
            },
        }),
        version: await tx.documentVersion.findFirst({
            where: {
                id: binding.versionId,
                documentId: binding.documentId,
                organizationId: org,
            },
            select: {
                id: true,
                status: true,
                contentState: true,
                discardedAt: true,
                sha256: true,
                byteSize: true,
            },
        }),
        extraction: await tx.documentExtraction.findFirst({
            where: { versionId: binding.versionId, organizationId: org },
            select: {
                id: true,
                discardedAt: true,
                byteSize: true,
                extractorVersion: true,
            },
        }),
        liveClaims: await tx.indexTask.count({
            where: { organizationId: org, leaseToken: { not: null } },
        }),
        taskCount: await tx.indexTask.count({
            where: { organizationId: org, collectionId: binding.collectionId },
        }),
        usage: await tx.collectionIndexAccounting.findUnique({
            where: { collectionId: binding.collectionId },
            select: {
                activeChunks: true,
                retainedChunks: true,
                reservedChunks: true,
            },
        }),
    };
}
/** Keep native READ ONLY transaction failures behind a fixed stage; never inspect database error payloads. */
export async function readVectorAppSnapshot(app, fixture, binding) {
    try {
        return await app.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
                await tx.$executeRawUnsafe('SET LOCAL statement_timeout=10000');
                return readVectorSnapshot(tx, fixture, binding);
            },
            { isolationLevel: 'RepeatableRead', maxWait: 1000, timeout: 15000 }
        );
    } catch (error) {
        let known = false;
        try {
            known = error instanceof RecipeError;
        } catch {
            /* hostile values remain unknown */
        }
        if (known) throw error;
        failure(false, 'READ_APP_SNAPSHOT');
    }
}
export async function vectorPool(state) {
    const uri = new URL(state.environment.VECTOR_DATABASE_URL);
    failure(
        uri.protocol === 'postgresql:' &&
            uri.hostname === '127.0.0.1' &&
            Number(uri.port) === state.ports.vector &&
            uri.username === 'vectorix_runtime' &&
            uri.pathname === '/' + state.vectorDatabase &&
            !uri.search &&
            !uri.hash,
        'PHYSICAL_DATABASE'
    );
    const fromVector = createRequire(
            path.join(ROOT, 'packages/vector-store/package.json')
        ),
        entry = fromVector.resolve('pg');
    failure(
        Object.values(state.inputs.runtime).some(
            (r) =>
                r.name === 'pg' &&
                fs.realpathSync(entry).startsWith(r.root + path.sep)
        ),
        'PHYSICAL_RUNTIME'
    );
    const { Pool } = fromVector('pg');
    return new Pool({
        connectionString: uri.href,
        max: 1,
        connectionTimeoutMillis: 5000,
        query_timeout: 10000,
        options:
            '-c default_transaction_read_only=on -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000',
    });
}
/** Only generated tables and saved IDs are admitted; no raw embedding vector is selected. */
export async function readPhysicalVector(
    pool,
    state,
    binding,
    assessment,
    { remainingMilliseconds }
) {
    const budget = () => {
        const remaining = remainingMilliseconds();
        failure(
            Number.isFinite(remaining) && remaining >= 1,
            'PHYSICAL_DEADLINE'
        );
        return Math.min(10000, Math.floor(remaining));
    };
    budget();
    const client = await pool.connect();
    const query = (text, values) =>
        client.query({ text, values, query_timeout: budget() });
    try {
        await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const identity = (
            await query(
                'SELECT current_database() AS database,identity::text,version FROM vector_collections.vx_identity WHERE singleton'
            )
        ).rows;
        failure(
            identity.length === 1 &&
                identity[0].database === state.vectorDatabase &&
                identity[0].version === 1,
            'PHYSICAL_IDENTITY'
        );
        const proof = [];
        for (const generationId of [
            binding.g1,
            ...(binding.g2 ? [binding.g2] : []),
        ]) {
            failure(
                /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u.test(
                    generationId
                ),
                'PHYSICAL_IDENTIFIER'
            );
            const manifest = assessment.manifests.find(
                    (row) => row.generationId === generationId
                ),
                table = 'g_' + generationId.replaceAll('-', '');
            const ledger = (
                await query(
                    'SELECT organization_id,collection_id,destination_fingerprint,shape,state FROM vector_collections.vx_generations WHERE id=$1',
                    [generationId]
                )
            ).rows;
            if (!manifest?.manifestSha256) {
                failure(
                    ledger.length === 0 &&
                        (
                            await query('SELECT to_regclass($1) AS relation', [
                                'vector_collections.' + table,
                            ])
                        ).rows[0].relation === null,
                    'PREMATURE_PROVISION'
                );
                proof.push({ generationId, provisioned: false });
                continue;
            }
            failure(
                ledger.length === 1 &&
                    ledger[0].organization_id === binding.organizationId &&
                    ledger[0].collection_id === binding.collectionId &&
                    ledger[0].state === 'READY' &&
                    same(ledger[0].shape, {
                        dimensions: 3,
                        metric: 'cosine',
                        numericType: 'float32',
                        indexType: 'HNSW',
                    }),
                'PHYSICAL_GENERATION'
            );
            const publications = (
                await query(
                    'SELECT id::text,document_id,source_version_id::text,expected_count,manifest_hash,state FROM vector_collections.vx_publications WHERE generation_id=$1 ORDER BY id LIMIT 2',
                    [generationId]
                )
            ).rows;
            failure(
                publications.length === 1 &&
                    publications[0].id === manifest.publicationId &&
                    publications[0].document_id === binding.documentId &&
                    publications[0].source_version_id === binding.versionId &&
                    publications[0].state === 'SEALED' &&
                    publications[0].expected_count === manifest.children &&
                    publications[0].manifest_hash === manifest.manifestSha256,
                'PHYSICAL_PUBLICATION'
            );
            const rows = (
                await query(
                    `SELECT chunk_id::text AS id,ordinal,chunk_hash AS hash,vector_hash AS "vectorHash",source_version_id::text AS "versionId",publication_id::text AS "publicationId",document_id AS "documentId",generation_id::text AS "generationId" FROM vector_collections."${table}" ORDER BY ordinal LIMIT 9`
                )
            ).rows;
            failure(
                rows.length === manifest.children &&
                    rows.every(
                        (r, i) =>
                            r.ordinal === i &&
                            r.versionId === binding.versionId &&
                            r.publicationId === manifest.publicationId &&
                            r.documentId === binding.documentId &&
                            r.generationId === generationId
                    ) &&
                    sha(
                        JSON.stringify(
                            rows.map((r) => [r.id, r.ordinal, r.hash])
                        )
                    ) === manifest.manifestSha256,
                'PHYSICAL_MANIFEST'
            );
            proof.push({
                generationId,
                provisioned: true,
                children: rows.length,
                publicationId: manifest.publicationId,
                sourceVersionId: manifest.sourceVersionId,
                manifestSha256: manifest.manifestSha256,
                destinationFingerprint: ledger[0].destination_fingerprint,
                rows,
            });
        }
        await query('COMMIT');
        return {
            identitySha256: sha(identity[0].identity),
            generations: proof,
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}
