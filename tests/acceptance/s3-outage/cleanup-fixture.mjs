/** One-shot native deletion of the single disposable cleanup fixture. Importing performs no I/O. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    HERE,
    ROOT,
    need,
    RecipeError,
    context,
    sameScope,
    receiptScope,
    privateBytes,
    privateJson,
    writePrivate,
    cleanEnvironment,
    entryError,
} from './private.mjs';

export const STATIC_DRAFT_ONLY = true;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);

/** Check the original watchdog immediately at dispatch, after the durable BEFORE record. */
export function requireDeleteBudget(
    state,
    ack,
    nowNs = process.hrtime.bigint()
) {
    need(
        state.scenario === 'CLEANUP_V1' &&
            sameScope(state, ack) &&
            ack.budgetSeconds === 900 &&
            ack.worker?.pid === state.processes.workers.pid &&
            ack.worker.startTicks === state.processes.workers.startTicks &&
            ack.rustfs?.id === state.resources.rustfs.id &&
            /^\d{1,30}$/u.test(ack.deadlineMonotonicNs) &&
            BigInt(ack.deadlineMonotonicNs) - nowNs >= 625000000000n,
        'S3_OUTAGE_CLEANUP_DELETE_ORIGINAL_BUDGET'
    );
}

/** The exact normal HTTP sequence has one DELETE; failures never retry a mutation. */
export async function executeCleanupFixture({
    state,
    fixture,
    baseline,
    ack,
    request,
    nowNs = () => process.hrtime.bigint(),
}) {
    need(
        state.scenario === 'CLEANUP_V1' &&
            sameScope(state, fixture) &&
            sameScope(state, baseline) &&
            baseline.phase === 'cleanup-ready' &&
            baseline.status === 'OBSERVED' &&
            baseline.faultEnrollmentAdmission?.kind === 'CLEANUP_READY_IDLE',
        'S3_OUTAGE_CLEANUP_DELETE_BASELINE'
    );
    const source = baseline.faultEnrollmentAdmission;
    need(
        source.organizationId === fixture.organization.id &&
            id(source.documentId) &&
            id(source.versionId),
        'S3_OUTAGE_CLEANUP_DELETE_BINDING'
    );
    let primary;
    try {
        const signedIn = await request('SIGN_IN', {
            email: fixture.users.owner.email,
            password: fixture.users.owner.password,
        });
        need(
            signedIn.user?.id === fixture.users.owner.userId,
            'S3_OUTAGE_CLEANUP_DELETE_USER'
        );
        await request('SET_ACTIVE', {
            organizationId: fixture.organization.id,
        });
        const current = await request('SESSION');
        need(
            current.user?.id === fixture.users.owner.userId &&
                current.session?.activeOrganizationId ===
                    fixture.organization.id,
            'S3_OUTAGE_CLEANUP_DELETE_SESSION'
        );
        const result = await request(
            'DELETE',
            { expectedVersionId: source.versionId, retentionDays: 0 },
            () => requireDeleteBudget(state, ack, nowNs())
        );
        need(
            result.success === true && Object.keys(result).length === 1,
            'S3_OUTAGE_CLEANUP_DELETE_RESPONSE'
        );
    } catch (error) {
        primary = error;
    } finally {
        try {
            need(
                (await request('SIGN_OUT', {})).success === true,
                'S3_OUTAGE_CLEANUP_DELETE_SIGNOUT'
            );
        } catch (error) {
            primary ??= error;
        }
    }
    if (primary) throw primary;
    return {
        documentId: source.documentId,
        versionId: source.versionId,
        retentionDays: 0,
        acceptance: 'CONFIRMED_NATIVE_HTTP',
        signOutConfirmed: true,
    };
}

async function main() {
    need(!STATIC_DRAFT_ONLY, 'S3_OUTAGE_CLEANUP_DELETE_DRAFT_REVIEW_REQUIRED');
    const { state, directory, recheck } = context(
        process.argv.slice(2),
        'staged-observe'
    );
    need(state.scenario === 'CLEANUP_V1', 'S3_OUTAGE_CLEANUP_SCENARIO');
    const fixture = privateJson(path.join(directory, 'fixture.json'), 16384),
        baselineBytes = privateBytes(
            path.join(directory, 'observe-cleanup-ready.json'),
            32768
        ),
        baseline = JSON.parse(baselineBytes),
        ackBytes = privateBytes(
            path.join(directory, 'watchdog-ack.json'),
            16384
        ),
        ack = JSON.parse(ackBytes);
    need(
        sameScope(state, ack) && ack.baselineSha256 === sha(baselineBytes),
        'S3_OUTAGE_CLEANUP_DELETE_ENROLLMENT'
    );
    writePrivate(path.join(directory, 'cleanup-delete-intent.json'), {
        ...receiptScope(state),
        status: 'ONE_SHOT_EFFECTS_UNKNOWN',
        baselineSha256: sha(baselineBytes),
        watchdogAckSha256: sha(ackBytes),
        at: new Date().toISOString(),
    });
    const source = baseline.faultEnrollmentAdmission,
        jar = new Map(),
        started = performance.now();
    const routes = {
        SIGN_IN: ['/api/auth/sign-in/email', 'POST'],
        SET_ACTIVE: ['/api/auth/organization/set-active', 'POST'],
        SESSION: ['/api/auth/get-session', 'GET'],
        DELETE: [`/api/v1/admin/rag/documents/${source.documentId}`, 'DELETE'],
        SIGN_OUT: ['/api/auth/sign-out', 'POST'],
    };
    let requests = 0;
    async function request(operation, body, beforeDispatch) {
        need(
            Object.hasOwn(routes, operation) && ++requests <= 5,
            'S3_OUTAGE_CLEANUP_DELETE_REQUEST_BOUND'
        );
        recheck();
        need(
            !fs.existsSync(
                path.join(directory, 'watchdog-intervention.json')
            ) &&
                sha(
                    privateBytes(
                        path.join(directory, 'watchdog-ack.json'),
                        16384
                    )
                ) === sha(ackBytes),
            'S3_OUTAGE_CLEANUP_DELETE_ENROLLMENT'
        );
        const [route, method] = routes[operation],
            serialized = method === 'GET' ? undefined : JSON.stringify(body);
        need(
            serialized === undefined || Buffer.byteLength(serialized) <= 4096,
            'S3_OUTAGE_CLEANUP_DELETE_REQUEST_BOUND'
        );
        const ordinal = requests;
        writePrivate(
            path.join(directory, `cleanup-delete-${ordinal}-before.json`),
            {
                ...receiptScope(state),
                operation,
                ordinal,
                status: null,
                at: new Date().toISOString(),
            }
        );
        let status = null;
        try {
            const remaining =
                operation === 'SIGN_OUT'
                    ? 10000
                    : Math.min(10000, 120000 - (performance.now() - started));
            need(remaining > 0, 'S3_OUTAGE_CLEANUP_DELETE_DEADLINE');
            beforeDispatch?.(); // The 625-second check follows the synchronous durable receipt.
            const response = await fetch(
                `http://127.0.0.1:${state.ports.api}${route}`,
                {
                    method,
                    redirect: 'manual',
                    signal: AbortSignal.timeout(
                        Math.max(1, Math.floor(remaining))
                    ),
                    headers: {
                        origin: `http://127.0.0.1:${state.ports.web}`,
                        'Vectorix-CSRF': 'orpc',
                        'Vectorix-Expected-Organization-Id':
                            fixture.organization.id,
                        cookie: [...jar]
                            .map(([key, value]) => `${key}=${value}`)
                            .join('; '),
                        ...(serialized === undefined
                            ? {}
                            : { 'content-type': 'application/json' }),
                    },
                    body: serialized,
                }
            );
            status = response.status;
            const cookies = response.headers.getSetCookie();
            need(
                cookies.length <= 16 &&
                    cookies.reduce((sum, item) => sum + item.length, 0) <=
                        32768,
                'S3_OUTAGE_CLEANUP_DELETE_COOKIE_CAP'
            );
            for (const cookie of cookies) {
                const pair = cookie.split(';', 1)[0],
                    split = pair.indexOf('=');
                need(
                    split > 0 &&
                        split < 128 &&
                        pair.length <= 8192 &&
                        !/[\r\n\x00-\x20\x7f]/u.test(pair) &&
                        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(
                            pair.slice(0, split)
                        ),
                    'S3_OUTAGE_CLEANUP_DELETE_COOKIE'
                );
                const name = pair.slice(0, split),
                    value = pair.slice(split + 1);
                need(
                    jar.has(name) || jar.size < 16,
                    'S3_OUTAGE_CLEANUP_DELETE_COOKIE_CAP'
                );
                if (value) jar.set(name, value);
                else jar.delete(name);
            }
            const reader = response.body?.getReader(),
                parts = [];
            let bytes = 0;
            try {
                if (reader)
                    while (true) {
                        const part = await reader.read();
                        if (part.done) break;
                        bytes += part.value.byteLength;
                        need(
                            bytes <= 131072,
                            'S3_OUTAGE_CLEANUP_DELETE_RESPONSE_CAP'
                        );
                        parts.push(Buffer.from(part.value));
                    }
            } finally {
                if (reader) {
                    void reader.cancel().catch(() => {});
                    try {
                        reader.releaseLock();
                    } catch {
                        /* pending read */
                    }
                }
            }
            need(
                status === 200,
                'S3_OUTAGE_CLEANUP_DELETE_HTTP_UNKNOWN_NO_REPLAY'
            );
            let result;
            try {
                result = JSON.parse(Buffer.concat(parts));
            } catch {
                throw new RecipeError('S3_OUTAGE_CLEANUP_DELETE_RESPONSE');
            }
            need(
                result && typeof result === 'object' && !Array.isArray(result),
                'S3_OUTAGE_CLEANUP_DELETE_RESPONSE'
            );
            return result;
        } finally {
            writePrivate(
                path.join(directory, `cleanup-delete-${ordinal}-after.json`),
                {
                    ...receiptScope(state),
                    operation,
                    ordinal,
                    status,
                    at: new Date().toISOString(),
                }
            );
        }
    }
    try {
        const result = await executeCleanupFixture({
            state,
            fixture,
            baseline,
            ack,
            request,
        });
        recheck();
        writePrivate(path.join(directory, 'cleanup-delete-receipt.json'), {
            ...receiptScope(state),
            ...result,
            baselineSha256: sha(baselineBytes),
            watchdogAckSha256: sha(ackBytes),
            at: new Date().toISOString(),
        });
        console.log(
            JSON.stringify({
                ...receiptScope(state),
                completed: true,
                operation: 'cleanup-delete',
                acceptance: 'CONFIRMED_NATIVE_HTTP',
            })
        );
    } catch (error) {
        // Independent safety path; this never makes the failed invocation reusable or successful.
        const result = spawnSync(
            'python3',
            [
                path.join(HERE, 'fault.py'),
                '--run',
                state.runId,
                '--scenario',
                state.scenario,
                '--mode',
                'abort-incomplete',
            ],
            {
                cwd: ROOT,
                env: cleanEnvironment(),
                timeout: 65000,
                maxBuffer: 4096,
                stdio: ['ignore', 'pipe', 'ignore'],
            }
        );
        writePrivate(path.join(directory, 'cleanup-delete-incomplete.json'), {
            ...receiptScope(state),
            status: 'INCOMPLETE',
            safetyRestoreCommandCompleted: result.status === 0,
            effects: 'UNKNOWN_NO_REPLAY',
            at: new Date().toISOString(),
        });
        throw error;
    } finally {
        jar.clear();
    }
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
