import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Credential } from '../types';
import {
    credentialFormData,
    requiresSecretReentry,
} from './credential-form-data';

const endpoint = 'https://storage.example.test';
const s3 = {
    provider: 'S3',
    endpoint,
    region: 'us-east-1',
    bucket: 'archive',
    forcePathStyle: true,
    accessKeyId: '********',
    secretAccessKey: '********',
} as const satisfies Credential['data'];

function fields(values: Record<string, string> = {}) {
    const form = new FormData();
    for (const [name, value] of Object.entries({
        endpoint,
        region: 'us-east-1',
        bucket: 'archive',
        forcePathStyle: 'on',
        ...values,
    }))
        form.set(name, value);
    return form;
}

function s3FormData(form: FormData) {
    const data = credentialFormData(form, 'S3', true);
    assert.ok('accessKeyId' in data);
    return data;
}

function keyFormData(
    form: FormData,
    provider: Exclude<Credential['provider'], 'S3'>,
    updating = true
) {
    const data = credentialFormData(form, provider, updating);
    assert.ok('apiKey' in data);
    return data;
}

void test('unchanged S3 destinations and region-only edits preserve empty edit secrets', () => {
    const form = fields({ region: 'eu-west-1' });
    assert.equal(requiresSecretReentry(s3, form), false);
    assert.deepEqual(credentialFormData(form, 'S3', true), {
        provider: 'S3',
        endpoint,
        region: 'eu-west-1',
        bucket: 'archive',
        forcePathStyle: true,
        accessKeyId: undefined,
        secretAccessKey: undefined,
    });
});

void test('S3 endpoint, bucket and either addressing-mode transition require both edit fields', () => {
    assert.equal(
        requiresSecretReentry(
            s3,
            fields({ endpoint: 'https://other.example.test' })
        ),
        true
    );
    assert.equal(
        requiresSecretReentry(s3, fields({ bucket: 'another' })),
        true
    );
    const virtual = fields();
    virtual.delete('forcePathStyle');
    assert.equal(requiresSecretReentry(s3, virtual), true);
    assert.equal(s3FormData(virtual).forcePathStyle, false);
    assert.equal(
        requiresSecretReentry({ ...s3, forcePathStyle: false }, fields()),
        true
    );
});

void test('all keyed embedding providers require their key again for an endpoint edit', () => {
    for (const provider of [
        'OLLAMA',
        'COHERE',
        'VOYAGE',
        'OPENAI',
        'MISTRAL',
    ] as const) {
        const current = { provider, endpoint, apiKey: '********' } as const;
        assert.equal(requiresSecretReentry(current, fields()), false);
        assert.equal(
            requiresSecretReentry(
                current,
                fields({ endpoint: 'https://other.example.test' })
            ),
            true
        );
    }
});

void test('keyless Ollama and explicit key removal never silently reuse a stored key', () => {
    const current = {
        provider: 'OLLAMA',
        endpoint,
        apiKey: '********',
    } as const;
    const form = fields({ endpoint: 'https://other.example.test' });
    assert.equal(
        requiresSecretReentry({ ...current, apiKey: null }, form),
        false
    );
    form.set('removeKey', 'on');
    assert.equal(requiresSecretReentry(current, form), false);
    assert.equal(keyFormData(form, 'OLLAMA', true).apiKey, null);
    form.delete('removeKey');
    assert.equal(requiresSecretReentry(current, form), true);
});

void test('freshly entered secrets retain exact bytes and never come from masked metadata', () => {
    const form = fields({
        accessKeyId: ' access-id ',
        secretAccessKey: ' secret-bytes ',
        apiKey: ' provider-key ',
    });
    const data = s3FormData(form);
    assert.equal(data.accessKeyId, ' access-id ');
    assert.equal(data.secretAccessKey, ' secret-bytes ');
    assert.equal(keyFormData(form, 'COHERE', true).apiKey, ' provider-key ');
    assert.equal(keyFormData(fields(), 'COHERE').apiKey, undefined);
});

void test('Ollama creation, omitted edit key and explicit removal remain distinct', () => {
    const form = fields();
    assert.equal(keyFormData(form, 'OLLAMA', false).apiKey, null);
    assert.equal(keyFormData(form, 'OLLAMA', true).apiKey, undefined);
    form.set('apiKey', 'new-key');
    form.set('removeKey', 'on');
    assert.equal(keyFormData(form, 'OLLAMA', true).apiKey, null);
});
