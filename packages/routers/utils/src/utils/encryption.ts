import crypto from 'node:crypto';
import { promisify } from 'node:util';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 16 bytes for AES
const VERSION = 'v2';

const randomBytesAsync = promisify(crypto.randomBytes);

type KeyEntry = Readonly<{ id: string; key: Buffer }>;
type Keyring = Readonly<{
    current: KeyEntry;
    byId: ReadonlyMap<string, KeyEntry>;
}>;

let cached: { source: string; keyring: Keyring } | undefined;

function parseKey(value: string, name: string): KeyEntry {
    if (!/^[0-9a-f]{64}$/iu.test(value))
        throw new Error(`${name} must be 64 hex characters (32 bytes)`);
    const key = Buffer.from(value, 'hex');
    // A public fingerprint selects the key without revealing it.
    const id = crypto
        .createHash('sha256')
        .update(key)
        .digest('hex')
        .slice(0, 16);
    return { id, key };
}

/**
 * Current key from ENCRYPTION_SECRET plus optional retired keys from the
 * comma-separated ENCRYPTION_PREVIOUS_SECRETS, kept only for decryption during
 * rotation. Cached per distinct configuration.
 */
function getKeyring(): Keyring {
    const secret = process.env.ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error('ENCRYPTION_SECRET environment variable is not set');
    }
    const previous = process.env.ENCRYPTION_PREVIOUS_SECRETS ?? '';
    const source = `${secret}\n${previous}`;
    if (cached?.source === source) return cached.keyring;
    const current = parseKey(secret, 'ENCRYPTION_SECRET');
    const byId = new Map([[current.id, current]]);
    for (const [index, value] of previous.split(',').entries()) {
        if (!value.trim()) continue;
        const entry = parseKey(
            value.trim(),
            `ENCRYPTION_PREVIOUS_SECRETS entry ${index + 1}`
        );
        if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
    const keyring = { current, byId };
    cached = { source, keyring };
    return keyring;
}

/** Binds an organization credential secret to its organization, row and field. */
export function credentialSecretContext(
    organizationId: string,
    credentialId: string,
    field: 'accessKeyId' | 'secretAccessKey' | 'apiKey'
): string {
    return `vectorix:credential:${organizationId}:${credentialId}:${field}`;
}

/** Binds an encrypted push subscription to its organization and endpoint hash. */
export function pushSubscriptionContext(
    organizationId: string,
    endpointHash: string
): string {
    return `vectorix:push-subscription:${organizationId}:${endpointHash}`;
}

/**
 * Encrypt sensitive data using AES-256-GCM with the current key. `context`
 * becomes GCM associated data: the ciphertext only decrypts for the same
 * row/field binding. Format: v2:keyId:iv:authTag:data (hex fields).
 */
export async function encrypt(
    plaintext: string,
    context: string
): Promise<string> {
    const { current } = getKeyring();
    const iv = await randomBytesAsync(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, current.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${VERSION}:${current.id}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decipher(
    key: Buffer,
    [ivHex = '', authTagHex = '', encryptedHex = '']: readonly string[],
    context: string | null
): string {
    const decipherer = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(ivHex, 'hex')
    );
    if (context !== null) decipherer.setAAD(Buffer.from(context, 'utf8'));
    decipherer.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipherer
        .update(Buffer.from(encryptedHex, 'hex'))
        .toString('utf8');
    decrypted += decipherer.final('utf8');
    return decrypted;
}

/**
 * Decrypt a value written by `encrypt` for the same `context`. Legacy
 * `iv:authTag:data` values (no key ID, no associated data) are still read by
 * trying the current key, then each previous key. Any mismatch throws.
 */
export function decrypt(encryptedData: string, context: string): string {
    const keyring = getKeyring();
    const parts = encryptedData.split(':');
    if (parts.length === 5 && parts[0] === VERSION) {
        const entry = keyring.byId.get(parts[1] ?? '');
        if (!entry) throw new Error('Unknown encryption key');
        return decipher(entry.key, parts.slice(2), context);
    }
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted data format');
    }
    for (const entry of keyring.byId.values()) {
        try {
            return decipher(entry.key, parts, null);
        } catch {
            // Try the next configured key; the current key is first.
        }
    }
    throw new Error('Encrypted data cannot be decrypted with configured keys');
}

/** True for legacy values and values sealed with a retired key. */
export function needsReencryption(encryptedData: string): boolean {
    const parts = encryptedData.split(':');
    return !(
        parts.length === 5 &&
        parts[0] === VERSION &&
        parts[1] === getKeyring().current.id
    );
}

/**
 * Generate a random encryption key for use in ENCRYPTION_SECRET.
 * Run this once and store the output securely.
 */
export async function generateEncryptionKey(): Promise<string> {
    const bytes = await randomBytesAsync(32);
    return bytes.toString('hex');
}
