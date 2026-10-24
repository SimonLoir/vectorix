import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import {
    isAllowedEndpoint,
    parseEndpointAllowlist,
} from './endpoint-allowlist';

export type S3Configuration = {
    endpoint: string;
    region: string;
    bucket: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
};
export class StorageError extends Error {
    constructor() {
        super('Private object storage is unavailable.');
    }
}

/** Outbound destinations are operator-controlled; user-supplied endpoints alone never authorize network access. */
export function assertStorageEndpoint(endpoint: string) {
    const normalize = (value: string) => new URL(value).href.replace(/\/$/, '');
    const allowed = parseEndpointAllowlist(
        'storage',
        [
            {
                name: 'VECTORIX_DEFAULT_S3_ENDPOINT',
                value: process.env.VECTORIX_DEFAULT_S3_ENDPOINT,
            },
            {
                name: 'VECTORIX_S3_ALLOWED_ENDPOINTS',
                value: process.env.VECTORIX_S3_ALLOWED_ENDPOINTS,
                list: true,
            },
        ],
        normalize
    );
    if (!isAllowedEndpoint(endpoint, allowed, normalize))
        throw new StorageError();
}
function client(configuration: S3Configuration) {
    assertStorageEndpoint(configuration.endpoint);
    return new S3Client({
        endpoint: configuration.endpoint,
        region: configuration.region,
        forcePathStyle: configuration.forcePathStyle,
        credentials: {
            accessKeyId: configuration.accessKeyId,
            secretAccessKey: configuration.secretAccessKey,
        },
        maxAttempts: 2,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });
}
/** Write only private objects. Callers provide immutable, internally generated keys and content hashes. */
export async function putObject(
    config: S3Configuration,
    key: string,
    bytes: Uint8Array,
    sha256: string,
    mediaType: string
) {
    const s3 = client(config);
    try {
        await s3.send(
            new PutObjectCommand({
                Bucket: config.bucket,
                Key: key,
                Body: bytes,
                ContentLength: bytes.byteLength,
                ContentType: mediaType,
                Metadata: { sha256 },
            }),
            { abortSignal: AbortSignal.timeout(30_000) }
        );
    } catch {
        throw new StorageError();
    } finally {
        s3.destroy();
    }
}
/** A missing object is distinct from an inaccessible bucket or invalid credentials. */
export async function headObject(config: S3Configuration, key: string) {
    const s3 = client(config);
    try {
        const result = await s3.send(
            new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
            { abortSignal: AbortSignal.timeout(30_000) }
        );
        return {
            byteSize: result.ContentLength,
            sha256: result.Metadata?.sha256,
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'NotFound') return null;
        throw new StorageError();
    } finally {
        s3.destroy();
    }
}
/** Bound both advertised and streamed object sizes, and always close the response/client. */
export async function readObject(
    config: S3Configuration,
    key: string,
    maxBytes: number
) {
    const s3 = client(config);
    try {
        const response = await s3.send(
            new GetObjectCommand({ Bucket: config.bucket, Key: key }),
            { abortSignal: AbortSignal.timeout(30_000) }
        );
        if (!response.Body || (response.ContentLength ?? Infinity) > maxBytes)
            throw new StorageError();
        const reader = response.Body.transformToWebStream().getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                const chunk: unknown = next.value;
                if (!(chunk instanceof Uint8Array)) throw new StorageError();
                size += chunk.byteLength;
                if (size > maxBytes) throw new StorageError();
                chunks.push(chunk);
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        return Buffer.concat(chunks, size);
    } catch {
        throw new StorageError();
    } finally {
        s3.destroy();
    }
}
/** Only discard an abandoned object after a durable task owns its cleanup lease. */
export async function deleteObject(config: S3Configuration, key: string) {
    const s3 = client(config);
    try {
        await s3.send(
            new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
            { abortSignal: AbortSignal.timeout(30_000) }
        );
    } catch {
        throw new StorageError();
    } finally {
        s3.destroy();
    }
}
