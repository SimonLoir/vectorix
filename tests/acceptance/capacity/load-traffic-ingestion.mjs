/** Six normal tiny uploads per phase; no mutation is retried or seeded directly. */
import { randomUUID } from 'node:crypto';
import { need, sha, same } from './load-observer-core.mjs';
export const STATIC_DRAFT_ONLY = true;
export const INGEST_OFFSETS = Object.freeze([30000000, 80000000, 130000000]);
export function tinySource(runId, phase, organization, index) {
    need(
        /^[a-f0-9]{12}$/u.test(runId) &&
            ['paced', 'closed-loop'].includes(phase) &&
            ['A', 'B'].includes(organization) &&
            [0, 1, 2].includes(index),
        'LOAD_OBS_INGEST_INPUT'
    );
    const language = index % 2 === 0 ? 'EN' : 'FR',
        fileName = `m7c-traffic-${phase}-${organization}-${index + 1}.txt`,
        text =
            language === 'FR'
                ? `Document synthétique ${runId} ${phase} ${organization} ${index + 1}. Le support enregistre la réception et le contrôle. Café cafe\u0301 🧭.\n`
                : `Synthetic document ${runId} ${phase} ${organization} ${index + 1}. Support records the receipt and inspection.\n`,
        bytes = Buffer.from(text);
    return {
        fixtureId: fileName,
        fileName,
        mediaType: 'text/plain',
        language,
        text,
        originalBytes: bytes.length,
        originalSha256: sha(bytes),
        canonicalSha256: sha(text),
        canonicalLength: text.length,
        metadata: {
            topic: 'support',
            document_no: index + 1,
            active: true,
            dataset: 'm7c-traffic-' + phase,
        },
        tags: ['m7c-traffic', phase, organization.toLowerCase()],
    };
}
/** Serialize a separate IMPORT transport even though A/B flow state machines wait concurrently. */
export function serialTrafficApi(api, { check, maximumCalls = 2500 }) {
    let queue = Promise.resolve(),
        calls = 0;
    return {
        call(role, operation, input) {
            const next = queue.then(async () => {
                check();
                need(++calls <= maximumCalls, 'LOAD_OBS_INGEST_CALLS');
                return await api.call(role, operation, input);
            });
            queue = next.catch(() => {});
            return next;
        },
        calls: () => calls,
    };
}
export async function ingestTiny({
    runId,
    phase,
    organization,
    index,
    collection,
    api,
    now,
    sleep,
    deadline,
    journal,
}) {
    const source = tinySource(runId, phase, organization, index),
        role = organization === 'A' ? 'owner' : 'foreign',
        uploadIntentAt = now();
    let uploadHttp = null,
        validatedUploadResponseAt = null;
    const check = () => need(now() <= deadline, 'LOAD_OBS_TRAFFIC_DEADLINE');
    const call = async (operation, input) => {
        check();
        const result = await api.call(role, operation, input);
        check();
        if (operation === 'documents.upload') uploadHttp = result.http;
        return result.value;
    };
    const mutate = async (operation, input, validator) => {
        check();
        const requestId = input.requestId ?? randomUUID(),
            entry = {
                requestId,
                operation,
                organization,
                fixtureId: source.fixtureId,
                status: 'PENDING',
                inputSha256: sha(
                    JSON.stringify(input, (_key, value) =>
                        value instanceof File
                            ? {
                                  bytes: value.size,
                                  sha256: source.originalSha256,
                              }
                            : value
                    )
                ),
            };
        await journal({ ...entry });
        check();
        try {
            const result = await call(operation, input);
            validator(result);
            if (operation === 'documents.upload')
                validatedUploadResponseAt = now();
            await journal({ ...entry, status: 'ACCEPTED' });
            return result;
        } catch {
            await journal({ ...entry, status: 'UNKNOWN' });
            throw new Error('LOAD_OBS_INGEST_UNKNOWN');
        }
    };
    const uploaded = await mutate(
        'documents.upload',
        {
            requestId: randomUUID(),
            file: new File([source.text], source.fileName, {
                type: source.mediaType,
            }),
        },
        (value) =>
            need(
                typeof value.id === 'string' &&
                    typeof value.versionId === 'string',
                'LOAD_OBS_INGEST_UPLOAD'
            )
    );
    let readyAt = null;
    while (true) {
        const details = await call('documents.details', { id: uploaded.id });
        need(
            details.version?.id === uploaded.versionId &&
                details.version.version === 1 &&
                details.document?.name === source.fileName &&
                !['FAILED', 'DELETING'].includes(details.document.status),
            'LOAD_OBS_INGEST_SOURCE'
        );
        if (
            details.document.status === 'READY' &&
            details.version.status === 'READY'
        ) {
            need(
                details.version.byteSize === source.originalBytes &&
                    details.version.mediaType === source.mediaType &&
                    details.version.stored === true,
                'LOAD_OBS_INGEST_SOURCE'
            );
            readyAt = now();
            break;
        }
        await sleep(2000000);
    }
    const original = await call('documents.download', { id: uploaded.id }),
        preview = await call('documents.preview', {
            id: uploaded.id,
            offset: 0,
        });
    need(
        original instanceof File &&
            original.size === source.originalBytes &&
            sha(new Uint8Array(await original.arrayBuffer())) ===
                source.originalSha256 &&
            preview.text === source.text &&
            preview.nextOffset === null &&
            preview.version === 1,
        'LOAD_OBS_INGEST_SOURCE'
    );
    await mutate(
        'documents.setCollection',
        {
            id: uploaded.id,
            collectionId: collection.collectionId,
            attached: true,
        },
        (value) => need(value.success === true, 'LOAD_OBS_INGEST_ATTACH')
    );
    await mutate(
        'indexing.updateMetadata',
        {
            collectionId: collection.collectionId,
            documentId: uploaded.id,
            expectedMetadataRevision: 1,
            language: source.language,
            tags: source.tags,
            metadata: source.metadata,
        },
        (value) => need(value.success === true, 'LOAD_OBS_INGEST_METADATA')
    );
    while (true) {
        const page = await call('indexing.documents', {
            collectionId: collection.collectionId,
            offset: 0,
            limit: 100,
            query: '',
        });
        need(
            page.total <= 6 && page.items.length === page.total,
            'LOAD_OBS_INGEST_BOUND'
        );
        const row = page.items.find(
            (value) => value.documentId === uploaded.id
        );
        if (
            row?.indexedVersion === 1 &&
            row.libraryVersion === 1 &&
            row.pending === false &&
            row.freshness === 'CURRENT' &&
            row.errorCode === null &&
            row.language === source.language &&
            same(row.tags, source.tags) &&
            same(row.metadata, source.metadata)
        )
            break;
        await sleep(2000000);
    }
    return {
        binding: {
            fixtureId: source.fixtureId,
            documentId: uploaded.id,
            versionId: uploaded.versionId,
        },
        descriptor: { ...source, text: undefined },
        timing: {
            uploadIntentAtMicros: uploadIntentAt,
            uploadHTTP: uploadHttp
                ? {
                      startedMicros: uploadHttp.startedMicros,
                      bodyReadMicros: uploadHttp.bodyReadMicros,
                      endedMicros: uploadHttp.endedMicros,
                  }
                : null,
            validatedUploadResponseAtMicros: validatedUploadResponseAt,
            readyAtMicros: readyAt,
            observedCurrentAtMicros: now(),
            definition:
                'CLIENT_VALIDATED_UPLOAD_RESPONSE_TO_OBSERVED_READY_CURRENT_INCLUDES_QUEUE_RETRY_TIME_NOT_SERVER_COMMIT',
        },
    };
}
