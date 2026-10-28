import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    canCopyClientConfiguration,
    selectedClientCollection,
} from './client-selection';

const selection = {
    organizationId: 'organization-a',
    collection: { id: 'collection-a', name: 'Readable collection' },
};
const ready = {
    active: true,
    identityReady: true,
    permissionsReady: true,
    canRead: true,
    organizationId: 'organization-a',
    selection,
    collection: { id: 'collection-a', permissions: { read: true } },
    fetching: false,
    failed: false,
};

void test('changing organizations cannot combine a remembered collection with the new organization pin', () => {
    assert.deepEqual(
        selectedClientCollection(selection, 'organization-a'),
        selection.collection
    );
    for (const organizationId of ['organization-b', null, undefined]) {
        assert.equal(selectedClientCollection(selection, organizationId), null);
        assert.equal(
            canCopyClientConfiguration({ ...ready, organizationId }),
            false
        );
    }
    assert.equal(selectedClientCollection(null, 'organization-a'), null);
});

void test('copy requires the selected resource to be currently readable and match its organization-bound identity', () => {
    assert.equal(canCopyClientConfiguration(ready), true);
    assert.equal(
        canCopyClientConfiguration({ ...ready, selection: null }),
        false
    );
    assert.equal(
        canCopyClientConfiguration({ ...ready, collection: undefined }),
        false
    );
    assert.equal(
        canCopyClientConfiguration({
            ...ready,
            collection: { id: 'other-collection', permissions: { read: true } },
        }),
        false
    );
    assert.equal(
        canCopyClientConfiguration({
            ...ready,
            collection: { id: 'collection-a', permissions: { read: false } },
        }),
        false
    );
});

void test('identity refresh, permission loss and failed or refreshing reads keep templates non-copyable', () => {
    for (const change of [
        { active: false },
        { identityReady: false },
        { permissionsReady: false },
        { canRead: false },
        { fetching: true },
        { failed: true },
    ])
        assert.equal(
            canCopyClientConfiguration({ ...ready, ...change }),
            false
        );
});
