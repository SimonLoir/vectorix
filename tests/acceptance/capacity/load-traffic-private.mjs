/** Guarded exclusive traffic evidence writer. No filesystem operation on import. */
import fs from 'node:fs';
import path from 'node:path';
import { privateDirectory, privateCheckpoint } from './load-private.mjs';
import { need, digest, hash } from './load-observer-core.mjs';
export const STATIC_DRAFT_ONLY = false;
const MAX_BYTES = 32 * 1024 ** 2,
    MAX_EVENTS = 50000;
/** Closed projections prevent a receipt, query or thrown provider body from entering the mutation/event journal. */
export function trafficEventProjection(value) {
    need(
        ['paced', 'closed-loop'].includes(value.phase),
        'LOAD_OBS_TRAFFIC_JOURNAL'
    );
    if (value.kind === 'PHASE_PREPARED') {
        need(
            hash(value.beforeSha256) && hash(value.scheduleSha256),
            'LOAD_OBS_TRAFFIC_JOURNAL'
        );
        return {
            kind: value.kind,
            phase: value.phase,
            beforeSha256: value.beforeSha256,
            scheduleSha256: value.scheduleSha256,
        };
    }
    if (value.kind === 'SEARCH_INTENT') {
        need(
            /^[AB]\/[0-9]{1,5}$/u.test(value.id) &&
                /^[AB][0-4]$/u.test(value.client) &&
                value.organization === value.id[0] &&
                ['LEXICAL', 'VECTOR', 'HYBRID'].includes(value.mode) &&
                Number.isSafeInteger(value.dueMicros) &&
                value.dueMicros >= 0 &&
                value.dueMicros < 180000000 &&
                hash(value.requestSha256),
            'LOAD_OBS_TRAFFIC_JOURNAL'
        );
        return {
            kind: value.kind,
            phase: value.phase,
            id: value.id,
            client: value.client,
            organization: value.organization,
            mode: value.mode,
            dueMicros: value.dueMicros,
            requestSha256: value.requestSha256,
        };
    }
    if (value.kind === 'SEARCH_FINISHED') {
        need(
            /^[AB]\/[0-9]{1,5}$/u.test(value.id) &&
                value.outcome === 'SUCCESS' &&
                hash(value.responseSha256) &&
                /^[a-f0-9]{12}-[1-9][0-9]{0,5}$/u.test(value.http?.requestId) &&
                value.http.status === 200 &&
                [
                    'responseBytes',
                    'startedMicros',
                    'bodyReadMicros',
                    'endedMicros',
                ].every(
                    (key) =>
                        Number.isSafeInteger(value.http[key]) &&
                        value.http[key] >= 0
                ) &&
                value.http.bodyReadMicros >= value.http.startedMicros &&
                value.http.endedMicros >= value.http.bodyReadMicros,
            'LOAD_OBS_TRAFFIC_JOURNAL'
        );
        return {
            kind: value.kind,
            phase: value.phase,
            id: value.id,
            outcome: value.outcome,
            responseSha256: value.responseSha256,
            http: Object.fromEntries(
                [
                    'requestId',
                    'status',
                    'responseBytes',
                    'startedMicros',
                    'bodyReadMicros',
                    'endedMicros',
                ].map((key) => [key, value.http[key]])
            ),
        };
    }
    need(
        [
            'documents.upload',
            'documents.setCollection',
            'indexing.updateMetadata',
        ].includes(value.operation) &&
            ['PENDING', 'ACCEPTED', 'UNKNOWN'].includes(value.status),
        'LOAD_OBS_TRAFFIC_JOURNAL'
    );
    need(
        /^[a-f0-9-]{36}$/u.test(value.requestId) &&
            ['A', 'B'].includes(value.organization) &&
            /^m7c-traffic-(paced|closed-loop)-[AB]-[1-3]\.txt$/u.test(
                value.fixtureId
            ) &&
            hash(value.inputSha256),
        'LOAD_OBS_TRAFFIC_JOURNAL'
    );
    return {
        phase: value.phase,
        requestId: value.requestId,
        operation: value.operation,
        organization: value.organization,
        fixtureId: value.fixtureId,
        status: value.status,
        inputSha256: value.inputSha256,
    };
}
/** Caller must admit the exact load process before invoking; partial evidence is retained and never replayed. */
export async function createTrafficEvidenceStore({ directory, phase, admit }) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    await admit();
    privateDirectory(directory);
    need(['paced', 'closed-loop'].includes(phase), 'LOAD_OBS_TRAFFIC_JOURNAL');
    const fd = fs.openSync(
        path.join(directory, 'traffic-' + phase + '-journal.ndjson'),
        fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
        0o600
    );
    let parent;
    try {
        parent = fs.openSync(
            directory,
            fs.constants.O_RDONLY |
                fs.constants.O_DIRECTORY |
                fs.constants.O_NOFOLLOW
        );
        fs.fsyncSync(parent);
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    } finally {
        if (parent !== undefined) fs.closeSync(parent);
    }
    let queue = Promise.resolve(),
        bytes = 0,
        events = 0,
        closed = false;
    const journal = (value) => {
        const projected = trafficEventProjection(value),
            encoded = JSON.stringify(projected) + '\n';
        const next = queue.then(() => {
            need(
                !closed &&
                    value.phase === phase &&
                    ++events <= MAX_EVENTS &&
                    Buffer.byteLength(encoded) <= 2048 &&
                    bytes + Buffer.byteLength(encoded) <= MAX_BYTES,
                'LOAD_OBS_TRAFFIC_JOURNAL'
            );
            fs.writeFileSync(fd, encoded);
            fs.fsyncSync(fd);
            bytes += Buffer.byteLength(encoded);
        });
        queue = next;
        return next;
    };
    return {
        journal,
        async finishEvidence(report) {
            await queue;
            need(!closed && report.phase === phase, 'LOAD_OBS_TRAFFIC_JOURNAL');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            closed = true;
            privateCheckpoint(
                path.join(directory, 'traffic-' + phase + '-report.json'),
                report,
                true
            );
            return { phase, events, bytes, reportSha256: digest(report) };
        },
        async close() {
            try {
                await queue;
            } finally {
                if (!closed) {
                    try {
                        fs.fsyncSync(fd);
                    } finally {
                        fs.closeSync(fd);
                        closed = true;
                    }
                }
            }
        },
    };
}
