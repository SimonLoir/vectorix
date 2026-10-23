/** Synthetic restore setup only; no execution is approved by merely importing this draft. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const STATIC_DRAFT_ONLY = false;
if (STATIC_DRAFT_ONLY)
    throw new Error('Static restore account setup is not yet enabled.');
const run = process.argv[2];
assert.match(run ?? '', /^[a-f0-9]{12}$/);
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..'
);
const directory = path.join(
    root,
    'node_modules/.cache/vectorix/vectorix-m7c-restore-' + run
);
const directoryInfo = fs.lstatSync(directory);
assert(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink());
assert.equal(directoryInfo.mode & 0o777, 0o700);
assert.equal(directoryInfo.uid, process.getuid());
assert.equal(fs.realpathSync(directory), directory);
const statePath = path.join(directory, 'state.json');
function privateJson(file) {
    const descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const info = fs.fstatSync(descriptor);
        assert(info.isFile());
        assert.equal(info.mode & 0o777, 0o600);
        assert.equal(info.uid, process.getuid());
        assert(info.size <= 1024 * 1024);
        const bytes = Buffer.alloc(info.size + 1);
        const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
        assert.equal(count, info.size);
        return JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } finally {
        fs.closeSync(descriptor);
    }
}
const state = privateJson(statePath);
assert.equal(state.runId, run);
assert.equal(state.prefix, 'vectorix-m7c-restore-' + run);
assert.equal(state.phase, 'source-available-for-approved-dashboard-setup');
const database = new URL(state.environment.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, String(state.ports.postgres));
assert.equal(database.pathname, '/vectorix_m7c_app_' + run + '_test');
for (const [key, value] of Object.entries(state.environment))
    assert.equal(process.env[key], value);
assert.equal(process.env.VECTORIX_RESTORE_RUN, run);
assert.equal(process.env.VECTORIX_RESTORE_SIDE, 'source');
assert(!fs.existsSync(path.join(directory, 'fixture.json')));
const require = createRequire(path.join(root, 'apps/api/package.json'));
const { createORPCClient } = await import(require.resolve('@orpc/client'));
const { RPCLink } = await import(require.resolve('@orpc/client/fetch'));
const { prisma } = await import(require.resolve('@repo/db'));
const api = 'http://localhost:3101';
const web = 'http://localhost:3100';
assert.equal(state.environment.BETTER_AUTH_URL, api);
assert.equal(state.environment.VECTORIX_WEB_URL, web);
const roles = ['ownerA', 'readerA', 'ownerB', 'admin'];
const jars = Object.fromEntries(roles.map((role) => [role, new Map()]));
const headers = (role) => ({
    origin: web,
    cookie: [...jars[role]].map(([key, value]) => key + '=' + value).join('; '),
});
async function post(role, operation, body) {
    const response = await fetch(api + '/api/auth/' + operation, {
        method: 'POST',
        headers: { ...headers(role), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
    });
    for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0];
        const index = pair.indexOf('=');
        jars[role].set(pair.slice(0, index), pair.slice(index + 1));
    }
    assert(
        response.ok,
        'Synthetic authentication operation refused: ' + response.status
    );
    return response.json();
}
const client = (role) =>
    createORPCClient(
        new RPCLink({ url: api + '/rpc/v1', headers: () => headers(role) })
    );
const password = 'Vectorix-M7c-local-' + run + '-529!';
const users = {};
try {
    for (const role of roles) {
        if (role === 'admin')
            await new Promise((resolve) => setTimeout(resolve, 11000));
        const email = 'm7c-' + role.toLowerCase() + '-' + run + '@example.test';
        const result = await post(role, 'sign-up/email', {
            email,
            password,
            name: 'Restore ' + role,
        });
        assert.equal(result.user.email, email);
        users[role] = { userId: result.user.id, email };
    }
    const organizations = {};
    for (const suffix of ['A', 'B']) {
        organizations[suffix] = await post(
            'owner' + suffix,
            'organization/create',
            {
                name: 'M7c Restore ' + suffix,
                slug: 'm7c-' + run + '-' + suffix.toLowerCase(),
            }
        );
        await post('owner' + suffix, 'organization/set-active', {
            organizationId: organizations[suffix].id,
        });
    }
    const role = 'm7c-reader-' + run;
    await post('ownerA', 'organization/create-role', {
        organizationId: organizations.A.id,
        role,
        permission: {
            dashboard: ['read'],
            ragLibrary: ['read'],
            ragCollection: ['read'],
        },
    });
    await prisma.$transaction(async (tx) => {
        assert.equal(await tx.organization.count(), 2);
        assert.equal(await tx.user.count(), 4);
        for (const [suffix, expected] of Object.entries(organizations)) {
            const saved = await tx.organization.findUniqueOrThrow({
                where: { id: expected.id },
            });
            assert.equal(saved.slug, 'm7c-' + run + '-' + suffix.toLowerCase());
            users['owner' + suffix].memberId = (
                await tx.member.findFirstOrThrow({
                    where: {
                        organizationId: saved.id,
                        userId: users['owner' + suffix].userId,
                    },
                })
            ).id;
        }
        const reader = await tx.user.findUniqueOrThrow({
            where: { id: users.readerA.userId },
        });
        assert.equal(reader.email, users.readerA.email);
        users.readerA.memberId = randomUUID();
        // Synthetic fixture setup avoids external invitation delivery; product grants use authenticated APIs/UI.
        await tx.member.create({
            data: {
                id: users.readerA.memberId,
                userId: reader.id,
                organizationId: organizations.A.id,
                role,
                createdAt: new Date(),
            },
        });
        const operator = await tx.user.findUniqueOrThrow({
            where: { id: users.admin.userId },
        });
        assert.equal(operator.email, users.admin.email);
        assert.equal(
            await tx.member.count({ where: { userId: operator.id } }),
            0
        );
        await tx.user.update({
            where: { id: operator.id },
            data: { isSuperAdmin: true },
        });
        assert.equal(await tx.document.count(), 0);
        assert.equal(await tx.collection.count(), 0);
    });
    await post('readerA', 'organization/set-active', {
        organizationId: organizations.A.id,
    });
    const rag = client('ownerA').admin.rag;
    const group = await rag.groups.create({
        name: 'Restored restricted readers',
    });
    await rag.groups.addMember({
        id: group.id,
        memberId: users.readerA.memberId,
    });
    // Real supported credential encryption/activation with this owned RustFS destination only.
    const credential = await rag.credentials.create({
        name: 'Owned organization restore storage',
        data: {
            provider: 'S3',
            endpoint: state.environment.VECTORIX_DEFAULT_S3_ENDPOINT,
            region: 'us-east-1',
            bucket: state.buckets[1],
            forcePathStyle: true,
            accessKeyId: state.infrastructureSecrets.s3Access,
            secretAccessKey: state.infrastructureSecrets.s3Secret,
        },
    });
    await rag.credentials.activate({ id: credential.id });
    const fixture = {
        runId: run,
        prefix: state.prefix,
        organizationIds: Object.values(organizations).map((value) => value.id),
        collectionIds: [],
        documentIds: [],
        userIds: Object.values(users).map((value) => value.userId),
        users: Object.fromEntries(
            roles.map((key) => [key, { ...users[key], headers: headers(key) }])
        ),
        organizations: Object.fromEntries(
            Object.entries(organizations).map(([key, value]) => [
                key,
                { id: value.id, slug: value.slug },
            ])
        ),
        password,
        readerRole: role,
        readerGroupId: group.id,
        organizationStorageCredentialId: credential.id,
        status: 'account setup complete; dashboard documents and collections not yet created',
    };
    fs.writeFileSync(
        path.join(directory, 'fixture.json'),
        JSON.stringify(fixture, null, 2),
        { flag: 'wx', mode: 0o600 }
    );
    console.log(
        JSON.stringify({
            runId: run,
            organizationIds: fixture.organizationIds,
            accounts: roles.map((key) => users[key].email),
            status: 'owned synthetic setup completed; document/index/restore acceptance not run',
        })
    );
} finally {
    await prisma.$disconnect();
}
