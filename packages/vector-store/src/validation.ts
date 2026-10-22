import { createHash } from 'node:crypto';
import type {
    DestinationConfig,
    GenerationSpec,
    ManifestRow,
    PublicationSpec,
} from './types';
import { VectorStoreError } from './types';
export function fail(
    code: ConstructorParameters<typeof VectorStoreError>[0]
): never {
    throw new VectorStoreError(code);
}
export function uuid(value: string) {
    if (
        typeof value !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            value
        )
    )
        fail('INVALID_INPUT');
    return value;
}
export function identifier(value: string) {
    if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value))
        fail('INVALID_INPUT');
    return `"${value}"`;
}
export const generationTable = (id: string) =>
    `g_${uuid(id).replaceAll('-', '')}`;
export const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');
export function fingerprint(value: string) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        fail('INVALID_INPUT');
    return value;
}
/** Password rotation does not move a destination. Schema, database, host, port and TLS mode do. */
export function destinationTarget(config: DestinationConfig) {
    identifier(config.schema);
    const target = (raw: string) => {
        const value = new URL(raw);
        if (
            !['postgres:', 'postgresql:'].includes(value.protocol) ||
            !value.hostname ||
            !value.pathname.slice(1)
        )
            fail('INVALID_INPUT');
        const allowedParameters = new Set([
            'sslmode',
            'sslrootcert',
            'sslcert',
            'sslkey',
            'sslnegotiation',
            'uselibpqcompat',
            'application_name',
        ]);
        for (const key of value.searchParams.keys())
            if (
                !allowedParameters.has(key) ||
                value.searchParams.getAll(key).length !== 1
            )
                fail('INVALID_INPUT');
        const tls =
            value.searchParams.get('sslmode') ??
            (['sslrootcert', 'sslcert', 'sslkey'].some((key) =>
                value.searchParams.has(key)
            ) || value.searchParams.get('sslnegotiation') === 'direct'
                ? 'verify-full'
                : (process.env.PGSSLMODE ?? 'disable'));
        if (
            ![
                'disable',
                'prefer',
                'require',
                'verify-ca',
                'verify-full',
                'no-verify',
            ].includes(tls)
        )
            fail('INVALID_INPUT');
        if (
            value.searchParams.has('sslnegotiation') &&
            !['direct', 'postgres'].includes(
                value.searchParams.get('sslnegotiation')!
            )
        )
            fail('INVALID_INPUT');
        if (
            value.searchParams.has('uselibpqcompat') &&
            !['true', 'false'].includes(
                value.searchParams.get('uselibpqcompat')!
            )
        )
            fail('INVALID_INPUT');
        return JSON.stringify([
            value.hostname.toLowerCase(),
            value.port || '5432',
            decodeURI(value.pathname.slice(1)),
            config.schema,
            tls,
            value.searchParams.get('sslnegotiation') ?? 'postgres',
            value.searchParams.get('uselibpqcompat') ?? 'false',
            value.searchParams.has('sslrootcert'),
        ]);
    };
    try {
        const runtime = target(config.runtimeUrl);
        if (
            config.provisioningUrl &&
            runtime !== target(config.provisioningUrl)
        )
            fail('DESTINATION_DRIFT');
        return runtime;
    } catch (error) {
        if (error instanceof VectorStoreError) throw error;
        return fail('INVALID_INPUT');
    }
}
export function validateGeneration(spec: GenerationSpec) {
    uuid(spec.id);
    fingerprint(spec.destinationFingerprint);
    if (
        !spec.organizationId ||
        spec.organizationId.length > 200 ||
        !spec.collectionId ||
        spec.collectionId.length > 200 ||
        spec.metric !== 'cosine' ||
        spec.numericType !== 'float32' ||
        !['HNSW', 'DISKANN'].includes(spec.indexType) ||
        !Number.isInteger(spec.dimensions) ||
        spec.dimensions < 1 ||
        spec.dimensions > (spec.indexType === 'HNSW' ? 2000 : 16_000)
    )
        fail('INVALID_INPUT');
}
export function validatePublication(spec: PublicationSpec) {
    uuid(spec.id);
    uuid(spec.sourceVersionId);
    fingerprint(spec.manifestHash);
    if (
        !spec.documentId ||
        spec.documentId.length > 200 ||
        !Number.isInteger(spec.expectedCount) ||
        spec.expectedCount < 1 ||
        spec.expectedCount > 100_000
    )
        fail('INVALID_INPUT');
}
export function epoch(value: bigint) {
    if (value < 1n || value > 9_223_372_036_854_775_807n) fail('INVALID_INPUT');
    return value.toString();
}
/** Canonical source/chunk manifest, independent of vector serialization and batch boundaries. */
export function manifestHash(rows: readonly ManifestRow[]) {
    if (!Array.isArray(rows) || rows.length > 100_000) fail('INVALID_INPUT');
    return sha256(
        JSON.stringify(
            rows
                .toSorted((a, b) => a.ordinal - b.ordinal)
                .map((row: ManifestRow) => {
                    uuid(row.chunkId);
                    fingerprint(row.chunkHash);
                    if (
                        !Number.isInteger(row.ordinal) ||
                        row.ordinal < 0 ||
                        row.ordinal >= 100_000
                    )
                        fail('INVALID_INPUT');
                    return [row.chunkId, row.ordinal, row.chunkHash];
                })
        )
    );
}
/** pgvector stores float32. Reject overflow and cosine-zero after rounding, including underflow. */
export function vectorLiteral(value: readonly number[], dimensions: number) {
    if (!Array.isArray(value) || value.length !== dimensions)
        fail('INVALID_INPUT');
    const vector = value.map((x: number) => {
        const converted = Math.fround(x);
        if (!Number.isFinite(x) || !Number.isFinite(converted))
            fail('INVALID_INPUT');
        return Object.is(converted, -0) ? 0 : converted;
    });
    if (!vector.some((x) => x !== 0)) fail('INVALID_INPUT');
    return `[${vector.join(',')}]`;
}
