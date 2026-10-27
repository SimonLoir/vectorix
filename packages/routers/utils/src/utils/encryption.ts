import crypto from 'node:crypto';
import { promisify } from 'node:util';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const VERSION = 'v2';
const MAX_PREVIOUS_KEYS = 16;
const randomBytesAsync = promisify(crypto.randomBytes);

type KeyEntry = Readonly<{ id: string; key: Buffer }>;
type Keyring = Readonly<{
    current: KeyEntry;
    byId: ReadonlyMap<string, KeyEntry>;
}>;
type Envelope = Readonly<{
    keyId: string | null;
    iv: string;
    tag: string;
    data: string;
}>;
let cached: { source: string; keyring: Keyring } | undefined;

/** A deployment keyring problem is never evidence that a stored row is corrupt. */
export class EncryptionConfigurationError extends Error {
    constructor(message = 'Invalid encryption keyring configuration.') {
        super(message);
        this.name = 'EncryptionConfigurationError';
    }
}

/** Missing retired keys, including ambiguous legacy failures, must not revoke devices. */
export class EncryptionKeyUnavailableError extends Error {
    constructor() {
        super('A configured encryption key cannot read this value.');
        this.name = 'EncryptionKeyUnavailableError';
    }
}

/** A strictly parsed value failed authentication with its selected available key. */
export class EncryptedDataError extends Error {
    constructor() {
        super('Invalid encrypted data.');
        this.name = 'EncryptedDataError';
    }
}

function parseKey(value: string, name: string): KeyEntry {
    if (!/^[0-9a-f]{64}$/iu.test(value))
        throw new EncryptionConfigurationError(
            `${name} must be 64 hex characters (32 bytes)`
        );
    const key = Buffer.from(value, 'hex');
    const id = crypto
        .createHash('sha256')
        .update(key)
        .digest('hex')
        .slice(0, 16);
    return { id, key };
}

/** Current and at most sixteen retired keys; only the latest raw configuration is cached. */
function getKeyring(): Keyring {
    const secret = process.env.ENCRYPTION_SECRET;
    if (!secret)
        throw new EncryptionConfigurationError('ENCRYPTION_SECRET is not set');
    const previous = process.env.ENCRYPTION_PREVIOUS_SECRETS ?? '';
    const source = `${secret}\n${previous}`;
    if (cached?.source === source) return cached.keyring;
    if (previous.length > 4096)
        throw new EncryptionConfigurationError(
            'ENCRYPTION_PREVIOUS_SECRETS is too long'
        );
    const values = previous.split(',').filter((value) => value.trim());
    if (values.length > MAX_PREVIOUS_KEYS)
        throw new EncryptionConfigurationError(
            'ENCRYPTION_PREVIOUS_SECRETS has too many entries'
        );
    const current = parseKey(secret, 'ENCRYPTION_SECRET');
    const byId = new Map([[current.id, current]]);
    for (const [index, value] of previous.split(',').entries()) {
        if (!value.trim()) continue;
        const entry = parseKey(
            value.trim(),
            `ENCRYPTION_PREVIOUS_SECRETS entry ${index + 1}`
        );
        const duplicate = byId.get(entry.id);
        if (duplicate && !duplicate.key.equals(entry.key))
            throw new EncryptionConfigurationError(
                'Encryption key fingerprints collide'
            );
        byId.set(entry.id, entry);
    }
    const keyring = { current, byId };
    cached = { source, keyring };
    return keyring;
}

/** Validate keyring configuration even when an operator scan has no rows. */
export function assertEncryptionConfiguration(): void {
    getKeyring();
}

/** Binds an organization credential secret to its organization, row and field. */
export function credentialSecretContext(
    organizationId: string,
    credentialId: string,
    field: 'accessKeyId' | 'secretAccessKey' | 'apiKey'
): string {
    return `vectorix:credential:${organizationId}:${credentialId}:${field}`;
}

/** Binds a self-hosted reranking secret to its organization and endpoint row, separate from legacy credentials. */
export function rerankEndpointSecretContext(
    organizationId: string,
    endpointId: string
): string {
    return `vectorix:rerank-endpoint:${organizationId}:${endpointId}:apiKey`;
}

/** Binds an encrypted push subscription to its organization and endpoint hash. */
export function pushSubscriptionContext(
    organizationId: string,
    endpointHash: string
): string {
    return `vectorix:push-subscription:${organizationId}:${endpointHash}`;
}

/** New values always use a sixteen-byte IV and full 128-bit authentication tag. */
export async function encrypt(
    plaintext: string,
    context: string
): Promise<string> {
    const { current } = getKeyring();
    const iv = await randomBytesAsync(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, current.key, iv, {
        authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const data = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
    return `${VERSION}:${current.id}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
}

/** Buffer's hex decoder accepts suffixes; validate every byte before decoding. */
function envelope(value: string): Envelope {
    const parts = value.split(':');
    let keyId: string | null = null;
    let fields = parts;
    if (parts.length === 5 && parts[0] === VERSION) {
        keyId = parts[1] ?? '';
        if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new EncryptedDataError();
        fields = parts.slice(2);
    } else if (parts.length !== 3) throw new EncryptedDataError();
    const [iv = '', tag = '', data = ''] = fields;
    if (
        !/^[0-9a-f]{32}$/iu.test(iv) ||
        !/^[0-9a-f]{32}$/iu.test(tag) ||
        !/^(?:[0-9a-f]{2})*$/iu.test(data)
    )
        throw new EncryptedDataError();
    return { keyId, iv, tag, data };
}

function decipher(
    key: Buffer,
    value: Envelope,
    context: string | null
): string {
    const reader = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(value.iv, 'hex'),
        { authTagLength: 16 }
    );
    if (context !== null) reader.setAAD(Buffer.from(context, 'utf8'));
    reader.setAuthTag(Buffer.from(value.tag, 'hex'));
    return (
        reader.update(Buffer.from(value.data, 'hex')).toString('utf8') +
        reader.final('utf8')
    );
}

/** Legacy data has no key identity: failed authentication can mean a missing old key. */
export function decrypt(encryptedData: string, context: string): string {
    const keyring = getKeyring();
    const value = envelope(encryptedData);
    if (value.keyId !== null) {
        const entry = keyring.byId.get(value.keyId);
        if (!entry) throw new EncryptionKeyUnavailableError();
        try {
            return decipher(entry.key, value, context);
        } catch {
            throw new EncryptedDataError();
        }
    }
    for (const entry of keyring.byId.values()) {
        try {
            return decipher(entry.key, value, null);
        } catch {
            /* Legacy envelopes do not identify which key is missing. */
        }
    }
    throw new EncryptionKeyUnavailableError();
}

/** Key/format selection only, not authentication; callers must decrypt before skipping a row. */
export function needsReencryption(encryptedData: string): boolean {
    return envelope(encryptedData).keyId !== getKeyring().current.id;
}

/** Generate a random encryption key; never replace the key of existing data blindly. */
export async function generateEncryptionKey(): Promise<string> {
    return (await randomBytesAsync(32)).toString('hex');
}
