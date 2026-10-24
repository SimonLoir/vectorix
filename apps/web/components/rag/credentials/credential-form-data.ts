import type { Credential } from '../types';

/** Blank edit secrets preserve ciphertext; only an explicit Ollama removal produces null. */
export function credentialFormData(
    form: FormData,
    provider: Credential['provider'],
    updating: boolean
) {
    const secret = (name: string) => String(form.get(name) ?? '') || undefined;
    const base = { provider, endpoint: String(form.get('endpoint')) };
    if (provider === 'S3')
        return {
            ...base,
            region: String(form.get('region')),
            bucket: String(form.get('bucket')),
            forcePathStyle: form.has('forcePathStyle'),
            accessKeyId: secret('accessKeyId'),
            secretAccessKey: secret('secretAccessKey'),
        };
    return {
        ...base,
        apiKey: form.has('removeKey')
            ? null
            : (secret('apiKey') ??
              (provider === 'OLLAMA' && !updating ? null : undefined)),
    };
}

/**
 * Mirror of the server rule: a new service URL or bucket must not reuse a
 * stored secret, so the dialog asks for it again. An Ollama credential with no
 * stored key, or whose key is being removed, has no secret to resend.
 */
export function requiresSecretReentry(
    current: Credential['data'],
    form: FormData
): boolean {
    const moved =
        String(form.get('endpoint') ?? '') !== current.endpoint ||
        (current.provider === 'S3' &&
            String(form.get('bucket') ?? '') !== current.bucket);
    if (!moved) return false;
    if (current.provider === 'OLLAMA')
        return current.apiKey !== null && !form.has('removeKey');
    return true;
}
