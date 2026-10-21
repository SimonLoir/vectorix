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
