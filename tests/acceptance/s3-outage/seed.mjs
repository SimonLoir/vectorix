/** One ordinary native-HTTP user and organization; no direct database writes. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    context,
    need,
    writePrivate,
    entryError,
    openFixturePrisma,
} from './private.mjs';

export const STATIC_DRAFT_ONLY = true;
const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
async function main() {
    need(!STATIC_DRAFT_ONLY, 'M7C_S3_OUTAGE_SEED_DRAFT_REVIEW_REQUIRED');
    const { state, run, directory } = context(process.argv.slice(2), 'seed');
    need(
        !fs.existsSync(path.join(directory, 'seed-intent.json')) &&
            !fs.existsSync(path.join(directory, 'fixture.json')),
        'M7C_S3_OUTAGE_SEED_NO_REPLAY'
    );
    writePrivate(path.join(directory, 'seed-intent.json'), {
        runId: run,
        status: 'STARTED_EFFECTS_UNKNOWN_UNTIL_FIXTURE',
    });
    const started = performance.now(),
        jars = new Map([['owner', new Map()]]);
    let requests = 0,
        client;
    const api = `http://127.0.0.1:${state.ports.api}`,
        web = `http://127.0.0.1:${state.ports.web}`;
    async function auth(role, operation, body) {
        need(
            jars.has(role) &&
                [
                    'sign-up/email',
                    'organization/create',
                    'organization/set-active',
                    'get-session',
                    'sign-out',
                ].includes(operation) &&
                ++requests <= 6 &&
                performance.now() - started < 120000,
            'M7C_S3_OUTAGE_AUTH_BOUNDS'
        );
        const jar = jars.get(role),
            method = operation === 'get-session' ? 'GET' : 'POST';
        const serialized =
            method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
        need(
            serialized === undefined || Buffer.byteLength(serialized) <= 4096,
            'M7C_S3_OUTAGE_AUTH_REQUEST_CAP'
        );
        const response = await fetch(api + '/api/auth/' + operation, {
            method,
            redirect: 'manual',
            signal: AbortSignal.timeout(
                Math.max(
                    1,
                    Math.min(
                        10000,
                        Math.floor(120000 - (performance.now() - started))
                    )
                )
            ),
            headers: {
                origin: web,
                cookie: [...jar]
                    .map(([key, value]) => key + '=' + value)
                    .join('; '),
                ...(serialized === undefined
                    ? {}
                    : { 'content-type': 'application/json' }),
            },
            body: serialized,
        });
        const cookies = response.headers.getSetCookie();
        need(
            cookies.length <= 16 &&
                cookies.reduce((size, value) => size + value.length, 0) <=
                    32768,
            'M7C_S3_OUTAGE_AUTH_COOKIE_CAP'
        );
        for (const cookie of cookies) {
            const pair = cookie.split(';', 1)[0],
                split = pair.indexOf('=');
            need(
                split > 0 &&
                    split < 128 &&
                    pair.length <= 8192 &&
                    !/[\r\n\x00-\x20\x7f]/u.test(pair) &&
                    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(pair.slice(0, split)),
                'M7C_S3_OUTAGE_AUTH_COOKIE'
            );
            const name = pair.slice(0, split),
                value = pair.slice(split + 1);
            need(
                jar.has(name) || jar.size < 16,
                'M7C_S3_OUTAGE_AUTH_COOKIE_CAP'
            );
            if (value) jar.set(name, value);
            else jar.delete(name);
        }
        need(
            response.status === 200,
            'M7C_S3_OUTAGE_AUTH_HTTP_REFUSED_NO_REPLAY'
        );
        const declared = response.headers.get('content-length');
        need(
            declared === null ||
                (/^\d+$/u.test(declared) && Number(declared) <= 128 * 1024),
            'M7C_S3_OUTAGE_AUTH_RESPONSE_CAP'
        );
        const reader = response.body?.getReader(),
            chunks = [];
        let bytes = 0;
        try {
            if (reader)
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    need(
                        bytes <= 128 * 1024,
                        'M7C_S3_OUTAGE_AUTH_RESPONSE_CAP'
                    );
                    chunks.push(Buffer.from(value));
                }
        } finally {
            if (reader) {
                void reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        }
        let value;
        try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            need(false, 'M7C_S3_OUTAGE_AUTH_RESPONSE');
        }
        need(
            value && typeof value === 'object' && !Array.isArray(value),
            'M7C_S3_OUTAGE_AUTH_RESPONSE'
        );
        return value;
    }
    try {
        client = await openFixturePrisma(state, true);
        const before = await Promise.all([
            client.user.count(),
            client.organization.count(),
            client.member.count(),
            client.session.count(),
            client.document.count(),
            client.collection.count(),
            client.apikey.count(),
        ]);
        need(
            JSON.stringify(before) === JSON.stringify([0, 0, 0, 0, 0, 0, 0]),
            'M7C_S3_OUTAGE_EMPTY_DATABASE'
        );
        need(
            await client.vectorixAccessControlState.findUnique({
                where: { id: 'vectorix-permissions-v1' },
                select: { id: true },
            }),
            'M7C_S3_OUTAGE_PERMISSIONS_INITIALIZED'
        );
        const email = `m7c-s3-outage-owner-${run}@example.test`,
            password = randomBytes(24).toString('base64url');
        const result = await auth('owner', 'sign-up/email', {
            name: `S3 recovery owner ${run}`,
            email,
            password,
        });
        need(
            id(result.user?.id) &&
                result.user.email === email &&
                result.user.emailVerified === false,
            'M7C_S3_OUTAGE_SIGNUP_IDENTITY'
        );
        const user = { userId: result.user.id, email, password };
        const slug = `m7c-s3-outage-${run}-owner`;
        const organization = await auth('owner', 'organization/create', {
            name: `S3 recovery organization ${run}`,
            slug,
        });
        need(
            id(organization.id) && organization.slug === slug,
            'M7C_S3_OUTAGE_ORGANIZATION_IDENTITY'
        );
        await auth('owner', 'organization/set-active', {
            organizationId: organization.id,
        });
        const session = await auth('owner', 'get-session');
        need(
            session.user?.id === user.userId &&
                session.session?.activeOrganizationId === organization.id,
            'M7C_S3_OUTAGE_NATIVE_ACTIVE_ORGANIZATION'
        );
        need(
            (await auth('owner', 'sign-out')).success === true,
            'M7C_S3_OUTAGE_SEED_SIGNOUT_REQUIRED'
        );
        context(['--run', run], 'check');
        const snapshot = await client.$transaction(
            async (tx) => {
                const counts = await Promise.all([
                    tx.user.count(),
                    tx.organization.count(),
                    tx.member.count(),
                    tx.session.count(),
                    tx.document.count(),
                    tx.collection.count(),
                    tx.apikey.count(),
                    tx.organizationGroup.count(),
                    tx.invitation.count(),
                ]);
                need(
                    JSON.stringify(counts) ===
                        JSON.stringify([1, 1, 1, 0, 0, 0, 0, 0, 0]),
                    'M7C_S3_OUTAGE_EXACT_COUNTS'
                );
                const account = await tx.user.findUnique({
                    where: { id: user.userId },
                    select: {
                        id: true,
                        email: true,
                        isSuperAdmin: true,
                        emailVerified: true,
                    },
                });
                const org = await tx.organization.findUnique({
                    where: { id: organization.id },
                    select: { id: true, slug: true, isActive: true },
                });
                const members = await tx.member.findMany({
                    where: {
                        userId: user.userId,
                        organizationId: organization.id,
                    },
                    select: {
                        id: true,
                        organizationId: true,
                        userId: true,
                        role: true,
                        createdAt: true,
                    },
                    take: 2,
                });
                need(
                    account?.email === email &&
                        account.isSuperAdmin === false &&
                        account.emailVerified === false &&
                        org?.slug === slug &&
                        org.isActive === true &&
                        members.length === 1 &&
                        members[0].role === 'owner',
                    'M7C_S3_OUTAGE_ORDINARY_NATIVE_FIXTURE'
                );
                return { members, activity: org };
            },
            { isolationLevel: 'RepeatableRead', maxWait: 1000, timeout: 15000 }
        );
        need(
            performance.now() - started < 120000,
            'M7C_S3_OUTAGE_SEED_DEADLINE'
        );
        writePrivate(path.join(directory, 'fixture.json'), {
            schemaVersion: 1,
            namespace: state.namespace,
            runId: run,
            users: { owner: user },
            organization: {
                id: organization.id,
                slug,
                name: organization.name,
            },
            membershipSnapshot: snapshot.members,
            activity: snapshot.activity,
            setup: {
                httpAccounts: 1,
                httpOrganizations: 1,
                directWrites: 'NONE_NATIVE_HTTP_ONLY',
                documents: 0,
                collections: 0,
                groups: 0,
                apiKeys: 0,
                invitations: 0,
                sessionsRetained: false,
            },
        });
        console.log(
            JSON.stringify({ completed: true, operation: 'seed', runId: run })
        );
    } finally {
        for (const jar of jars.values()) jar.clear();
        if (client) await client.$disconnect();
    }
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
