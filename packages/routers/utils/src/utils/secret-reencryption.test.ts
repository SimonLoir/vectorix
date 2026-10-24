import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, test } from 'node:test';
import { credentialSecretContext, decrypt, encrypt } from './encryption';
import {
    reencryptSecretColumns,
    reencryptionWindow,
    type ReencryptionColumn,
} from './secret-reencryption';

const first = 'a1'.repeat(32);
const second = 'b2'.repeat(32);
const saved = {
    current: process.env.ENCRYPTION_SECRET,
    previous: process.env.ENCRYPTION_PREVIOUS_SECRETS,
};
const context = (id: string) =>
    credentialSecretContext('rotation-test-org', id, 'apiKey');
function keys(current = second, previous: string | null = first) {
    process.env.ENCRYPTION_SECRET = current;
    if (previous === null) delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    else process.env.ENCRYPTION_PREVIOUS_SECRETS = previous;
}
afterEach(() => {
    if (saved.current === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = saved.current;
    if (saved.previous === undefined)
        delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    else process.env.ENCRYPTION_PREVIOUS_SECRETS = saved.previous;
});
function legacy(plaintext: string) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        Buffer.from(first, 'hex'),
        iv
    );
    const data = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
}
/** In-memory concurrency model only; production queries use the tested keyset builder. */
function memoryColumn(rows: Map<string, string>) {
    let updates = 0;
    let loads = 0;
    const hooks: {
        afterLoad?: (ordinal: number) => void;
        beforeUpdate?: (id: string) => void;
        afterUpdate?: (id: string) => void;
    } = {};
    const column: ReencryptionColumn = {
        name: 'cohereCredentials',
        fields: ['apiKey'],
        load: (after, take) => {
            const page = [...rows.entries()]
                .filter(([id]) => after === undefined || id > after)
                .toSorted(([a], [b]) => a.localeCompare(b))
                .slice(0, take)
                .map(([id, value]) => ({
                    id,
                    values: { apiKey: value },
                    context: () => context(id),
                }));
            hooks.afterLoad?.(++loads);
            return Promise.resolve(page);
        },
        update: (id, _field, previous, next) => {
            updates++;
            hooks.beforeUpdate?.(id);
            if (rows.get(id) !== previous) return Promise.resolve(0);
            rows.set(id, next);
            hooks.afterUpdate?.(id);
            return Promise.resolve(1);
        },
    };
    return { column, hooks, updates: () => updates, loads: () => loads };
}

void test('keyset reads survive deletion of the previous page boundary without relying on that row', async () => {
    keys();
    assert.deepEqual(reencryptionWindow('b', 2), {
        take: 2,
        where: { id: { gt: 'b' } },
    });
    const rows = new Map(
        ['a', 'b', 'c', 'd'].map((id) => [id, legacy(`value-${id}`)])
    );
    const fixture = memoryColumn(rows);
    fixture.hooks.afterUpdate = (id) => {
        if (id === 'b') rows.delete('b');
    };
    const report = await reencryptSecretColumns([fixture.column], {
        batchSize: 2,
    });
    assert.equal(report.status, 'COMPLETE');
    assert.equal(report.columns.cohereCredentials?.reencrypted, 4);
    assert.equal(rows.has('b'), false);
    for (const id of ['a', 'c', 'd'])
        assert.equal(decrypt(rows.get(id)!, context(id)), `value-${id}`);
});

void test('current-key corruption and wrong-row bindings are authenticated and cannot produce COMPLETE', async () => {
    keys(second, null);
    const sealed = await encrypt('sensitive-current-value', context('a'));
    const fields = sealed.split(':');
    fields[4] = (fields[4]!.startsWith('0') ? '1' : '0') + fields[4]!.slice(1);
    for (const [id, value] of [
        ['a', fields.join(':')],
        ['b', sealed],
        ['a', ''],
    ]) {
        const rows = new Map([[id!, value!]]);
        const fixture = memoryColumn(rows);
        const report = await reencryptSecretColumns([fixture.column]);
        assert.equal(report.status, 'INCOMPLETE');
        assert.equal(report.columns.cohereCredentials?.failed, 1);
        assert.equal(report.columns.cohereCredentials?.verificationFailed, 1);
        assert.equal(fixture.updates(), 0);
        assert.equal(rows.get(id!), value);
        assert.ok(!JSON.stringify(report).includes('sensitive-current-value'));
    }
});

void test('a lost CAS preserves concurrent edits and explicitly blocks completion until a fresh clean pass', async () => {
    keys();
    const rows = new Map([['a', legacy('initial-value')]]);
    const fixture = memoryColumn(rows);
    fixture.hooks.beforeUpdate = () =>
        rows.set('a', legacy('concurrent-value'));
    const report = await reencryptSecretColumns([fixture.column]);
    assert.equal(report.status, 'INCOMPLETE');
    assert.equal(report.columns.cohereCredentials?.conflicts, 1);
    assert.equal(report.columns.cohereCredentials?.remaining, 1);
    assert.equal(decrypt(rows.get('a')!, context('a')), 'concurrent-value');
    fixture.hooks.beforeUpdate = undefined;
    assert.equal(
        (await reencryptSecretColumns([fixture.column])).status,
        'COMPLETE'
    );
    keys(second, null);
    assert.equal(decrypt(rows.get('a')!, context('a')), 'concurrent-value');
});

void test('the final read-only verification catches an old-key insertion behind the write cursor', async () => {
    keys();
    const rows = new Map([['z', legacy('last-value')]]);
    const fixture = memoryColumn(rows);
    fixture.hooks.afterLoad = (ordinal) => {
        if (ordinal === 1) rows.set('a', legacy('inserted-value'));
    };
    const report = await reencryptSecretColumns([fixture.column], {
        batchSize: 2,
    });
    assert.equal(report.status, 'INCOMPLETE');
    assert.equal(report.columns.cohereCredentials?.remaining, 1);
    assert.equal(fixture.updates(), 1);
});

void test('dry runs authenticate and count candidates without any write or completion claim', async () => {
    keys();
    const rows = new Map([['a', legacy('old-value')]]);
    const before = rows.get('a');
    const fixture = memoryColumn(rows);
    const report = await reencryptSecretColumns([fixture.column], {
        dryRun: true,
    });
    assert.equal(report.status, 'DRY_RUN');
    assert.equal(report.columns.cohereCredentials?.authenticated, 1);
    assert.equal(report.columns.cohereCredentials?.wouldReencrypt, 1);
    assert.equal(report.columns.cohereCredentials?.reencrypted, 0);
    assert.equal(report.columns.cohereCredentials?.remaining, 1);
    assert.equal(fixture.updates(), 0);
    assert.equal(rows.get('a'), before);
});

void test('invalid page sizes refuse before any column I/O', async () => {
    keys();
    const fixture = memoryColumn(new Map());
    for (const batchSize of [
        0,
        -1,
        1.1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1001,
    ])
        await assert.rejects(
            reencryptSecretColumns([fixture.column], { batchSize })
        );
    assert.equal(fixture.loads(), 0);
});
