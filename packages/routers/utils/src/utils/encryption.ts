import crypto from 'node:crypto';
import { promisify } from 'node:util';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 16 bytes for AES

const randomBytesAsync = promisify(crypto.randomBytes);

/**
 * Get encryption key from environment variable.
 * The key should be 32 bytes (64 hex characters) for AES-256.
 */
function getEncryptionKey(): Buffer {
    const key = process.env.ENCRYPTION_SECRET;

    if (!key) {
        throw new Error('ENCRYPTION_SECRET environment variable is not set');
    }

    if (key.length !== 64) {
        throw new Error(
            'ENCRYPTION_SECRET must be 64 hex characters (32 bytes)'
        );
    }

    return Buffer.from(key, 'hex');
}

/**
 * Encrypt sensitive data using AES-256-GCM.
 * Returns a string in format: iv:authTag:encryptedData (all hex-encoded)
 */
export async function encrypt(plaintext: string): Promise<string> {
    const key = getEncryptionKey();
    const iv = await randomBytesAsync(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Return format: iv:authTag:encryptedData
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt data that was encrypted with the encrypt function.
 * Expects format: iv:authTag:encryptedData (all hex-encoded)
 */
export function decrypt(encryptedData: string): string {
    const key = getEncryptionKey();

    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted data format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts as [string, string, string];

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted).toString('utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * Generate a random encryption key for use in ENCRYPTION_KEY environment variable.
 * Run this once and store the output securely.
 */
export async function generateEncryptionKey(): Promise<string> {
    const bytes = await randomBytesAsync(32);
    return bytes.toString('hex');
}
