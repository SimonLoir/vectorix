/** Pure bounded manifest rules. Importing this module performs no file/network/database I/O. */
import { createHash } from 'node:crypto';
export const LIMITS = Object.freeze({
    objects: 128,
    objectBytes: 2 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
    versions: 8,
    extractions: 8,
    documents: 4,
    locations: 16,
    metadataBytes: 16384,
});
export class ObjectGuardError extends Error {}
export function requireObject(ok, label) {
    if (!ok) throw new ObjectGuardError(label);
}
export const sha256 = (bytes) =>
    createHash('sha256').update(bytes).digest('hex');
const hash = /^[a-f0-9]{64}$/u,
    identifier = /^[A-Za-z0-9_-]{1,128}$/u,
    uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/**
 * Match the production object-write protocol, independently of semantic MIME:
 * transferOriginal always writes binary; extraction process writes UTF-8 text
 * or JSON. Ownership and exact version-key validation remain separate guards.
 */
export function storedObjectContentType(kind, key) {
    requireObject(
        typeof key === 'string' && key.length > 0,
        'stored-object-key-required'
    );
    if (kind === 'ORIGINAL') return 'application/octet-stream';
    requireObject(kind === 'EXTRACTION', 'stored-object-kind');
    const suffix = key.split('/').at(-1);
    if (suffix === 'text.txt') return 'text/plain; charset=utf-8';
    if (suffix === 'extraction.json') return 'application/json; charset=utf-8';
    throw new ObjectGuardError('stored-extraction-suffix');
}
/** Finite diagnostic classes only; raw object/catalog MIME values never enter an error. */
export function mimeDiagnosticClass(value) {
    if (value === null || value === undefined) return 'missing';
    if (typeof value !== 'string') return 'other';
    const normalized = value.trim().toLowerCase();
    for (const [mediaType, name] of [
        ['text/plain', 'plain'],
        ['text/markdown', 'markdown'],
        ['application/json', 'json'],
    ]) {
        if (normalized === mediaType) return name;
        const suffix = normalized.slice(mediaType.length);
        if (
            normalized.startsWith(mediaType) &&
            /^;[ \t]*charset[ \t]*=[ \t]*utf-8$/u.test(suffix)
        ) {
            const spacing =
                suffix === ';charset=utf-8'
                    ? 'tight'
                    : suffix === '; charset=utf-8'
                      ? 'space'
                      : 'ows';
            return `${name}-utf8-${spacing}`;
        }
    }
    if (normalized === 'application/pdf') return 'pdf';
    if (
        normalized ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
        return 'docx';
    if (normalized === 'application/octet-stream') return 'binary';
    return 'other';
}
export function canonical(value) {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean'
    )
        return JSON.stringify(value);
    if (typeof value === 'number') {
        requireObject(Number.isSafeInteger(value), 'canonical-number');
        return String(value);
    }
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    requireObject(
        value &&
            typeof value === 'object' &&
            Object.getPrototypeOf(value) === Object.prototype,
        'canonical-value'
    );
    return (
        '{' +
        Object.keys(value)
            .sort(compare)
            .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
            .join(',') +
        '}'
    );
}
export function validateState(state, run) {
    requireObject(
        /^[a-f0-9]{12}$/u.test(run) &&
            state.version === 1 &&
            state.runId === run &&
            state.prefix === 'vectorix-m7c-restore-' + run,
        'state-run'
    );
    requireObject(
        state.applicationDatabase === 'vectorix_m7c_app_' + run + '_test' &&
            state.vectorDatabase === 'vectorix_m7c_vectors_' + run + '_test',
        'test-databases'
    );
    requireObject(
        Number.isInteger(state.ports.rustfs) &&
            state.ports.rustfs > 1024 &&
            state.ports.rustfs < 65536,
        's3-port'
    );
    const endpoint = 'http://127.0.0.1:' + state.ports.rustfs;
    requireObject(
        state.environment.VECTORIX_DEFAULT_S3_ENDPOINT === endpoint &&
            state.environment.VECTORIX_S3_ALLOWED_ENDPOINTS === endpoint,
        'exact-s3-endpoint'
    );
    requireObject(
        state.environment.VECTORIX_DEFAULT_S3_REGION === 'us-east-1' &&
            state.environment.VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE === 'true',
        'reviewed-s3-policy'
    );
    requireObject(
        canonical([...state.buckets].sort()) ===
            canonical([
                'm7c-' + run + '-organization',
                'm7c-' + run + '-platform',
            ]),
        'both-owned-buckets'
    );
    requireObject(
        state.environment.VECTORIX_DEFAULT_S3_BUCKET ===
            'm7c-' + run + '-platform',
        'platform-bucket'
    );
    requireObject(
        state.infrastructureSecrets?.s3Access === 'm7c-' + run &&
            typeof state.infrastructureSecrets?.s3Secret === 'string' &&
            /^[A-Za-z0-9_-]{32,128}$/u.test(
                state.infrastructureSecrets.s3Secret
            ) &&
            state.environment.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID ===
                state.infrastructureSecrets.s3Access &&
            state.environment.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY ===
                state.infrastructureSecrets.s3Secret,
        'owned-platform-credential-binding'
    );
    const db = new URL(state.environment.DATABASE_URL);
    requireObject(
        ['postgres:', 'postgresql:'].includes(db.protocol) &&
            db.hostname === '127.0.0.1' &&
            Number(db.port) === state.ports.postgres &&
            db.pathname === '/' + state.applicationDatabase &&
            !db.search &&
            !db.hash,
        'owned-application-binding'
    );
    return endpoint;
}
export function validateFixture(state, fixture) {
    requireObject(
        fixture.runId === state.runId && fixture.prefix === state.prefix,
        'fixture-run'
    );
    for (const [key, min, max] of [
        ['organizationIds', 2, 2],
        ['documentIds', 1, LIMITS.documents],
    ]) {
        const values = fixture[key];
        requireObject(
            Array.isArray(values) &&
                values.length >= min &&
                values.length <= max &&
                new Set(values).size === values.length &&
                values.every(
                    (value) =>
                        typeof value === 'string' && identifier.test(value)
                ),
            'fixture-identifiers'
        );
    }
    return fixture;
}
export function validateKey(key, fixture, documentOrganizations) {
    requireObject(
        typeof key === 'string' && Buffer.byteLength(key) <= 1024,
        'object-key-bound'
    );
    const pieces = key.split('/');
    requireObject(
        pieces.length === 4 &&
            fixture.organizationIds.includes(pieces[0]) &&
            fixture.documentIds.includes(pieces[1]) &&
            uuid.test(pieces[2]) &&
            ['original', 'text.txt', 'extraction.json'].includes(pieces[3]),
        'owned-object-key'
    );
    if (documentOrganizations)
        requireObject(
            documentOrganizations[pieces[1]] === pieces[0],
            'object-document-organization'
        );
    return pieces;
}
export function validateDestination(state, location, config) {
    const destination = {
        endpoint: location.endpoint,
        region: location.region,
        bucket: location.bucket,
        forcePathStyle: location.forcePathStyle,
    };
    requireObject(
        destination.endpoint === 'http://127.0.0.1:' + state.ports.rustfs &&
            destination.region === 'us-east-1' &&
            state.buckets.includes(destination.bucket) &&
            destination.forcePathStyle === true,
        'saved-owned-storage-destination'
    );
    for (const key of Object.keys(destination))
        requireObject(
            config[key] === destination[key],
            'bound-storage-destination-drift'
        );
    requireObject(
        typeof config.accessKeyId === 'string' &&
            config.accessKeyId.length > 0 &&
            typeof config.secretAccessKey === 'string' &&
            config.secretAccessKey.length > 0,
        'bound-storage-credentials-required'
    );
    return destination;
}
export function objectHeaders(head) {
    requireObject(
        [
            'ServerSideEncryption',
            'SSECustomerAlgorithm',
            'SSECustomerKeyMD5',
            'SSEKMSKeyId',
            'WebsiteRedirectLocation',
        ].every((key) => head[key] === undefined || head[key] === null) &&
            (head.BucketKeyEnabled === undefined ||
                head.BucketKeyEnabled === false),
        'unhandled-encryption-or-redirect'
    );
    requireObject(
        [
            'Expiration',
            'Restore',
            'ArchiveStatus',
            'ReplicationStatus',
            'ObjectLockMode',
            'ObjectLockRetainUntilDate',
            'ObjectLockLegalHoldStatus',
            'ObjectLockEventHold',
            'ObjectLockEventHoldDurationDays',
            'ObjectLockEventHoldDurationYears',
            'PartsCount',
            'RequestCharged',
        ].every((key) => head[key] === undefined || head[key] === null) &&
            (head.DeleteMarker === undefined || head.DeleteMarker === false) &&
            (head.MissingMeta === undefined || head.MissingMeta === 0) &&
            (head.TagCount === undefined || head.TagCount === 0) &&
            (head.VersionId === undefined || head.VersionId === 'null') &&
            (head.StorageClass === undefined ||
                head.StorageClass === 'STANDARD'),
        'unhandled-object-policy-or-version'
    );
    const names = {
        ContentType: 'contentType',
        CacheControl: 'cacheControl',
        ContentDisposition: 'contentDisposition',
        ContentEncoding: 'contentEncoding',
        ContentLanguage: 'contentLanguage',
    };
    const headers = {};
    for (const [input, key] of Object.entries(names)) {
        const value = head[input] ?? null;
        requireObject(
            value === null ||
                (typeof value === 'string' &&
                    Buffer.byteLength(value) <= 2048 &&
                    !/[\u0000-\u001f\u007f]/u.test(value)),
            'bounded-system-header'
        );
        headers[key] = value;
    }
    const expires = head.Expires ?? null;
    requireObject(
        expires === null ||
            (expires instanceof Date && Number.isFinite(expires.getTime())),
        'expiry-header'
    );
    headers.expires = expires?.toISOString() ?? null;
    const metadata = head.Metadata ?? {};
    requireObject(
        metadata &&
            typeof metadata === 'object' &&
            !Array.isArray(metadata) &&
            Object.keys(metadata).length <= 32,
        'bounded-object-metadata'
    );
    for (const [key, value] of Object.entries(metadata))
        requireObject(
            /^[a-z0-9_-]{1,128}$/u.test(key) &&
                typeof value === 'string' &&
                Buffer.byteLength(value) <= 2048,
            'metadata-shape'
        );
    requireObject(
        Buffer.byteLength(canonical(metadata)) <= LIMITS.metadataBytes,
        'metadata-total-bound'
    );
    requireObject(
        metadata.sha256 === undefined || hash.test(metadata.sha256),
        'sha-metadata-shape'
    );
    return {
        headers,
        metadata: { ...metadata },
        shaMetadataState: metadata.sha256 === undefined ? 'MISSING' : 'PRESENT',
    };
}
export function validateObjectBytes(bytes, advertised, descriptor) {
    requireObject(
        Number.isSafeInteger(advertised) &&
            advertised >= 0 &&
            advertised <= LIMITS.objectBytes,
        'head-object-byte-cap'
    );
    requireObject(
        bytes.byteLength === advertised &&
            bytes.byteLength <= LIMITS.objectBytes,
        'actual-object-byte-cap'
    );
    const digest = sha256(bytes);
    requireObject(
        descriptor.metadata.sha256 === undefined ||
            descriptor.metadata.sha256 === digest,
        'actual-metadata-sha-mismatch'
    );
    return { bytes: bytes.byteLength, sha256: digest, ...descriptor };
}
export function buildManifest(
    state,
    fixture,
    bindings,
    inventory,
    documentOrganizations
) {
    validateState(state, state.runId);
    validateFixture(state, fixture);
    requireObject(
        Array.isArray(bindings) &&
            bindings.length <= LIMITS.versions + LIMITS.extractions &&
            Array.isArray(inventory) &&
            inventory.length <= LIMITS.objects,
        'manifest-count-bound'
    );
    const locations = new Map(),
        objectMap = new Map();
    let total = 0;
    const objects = [...inventory]
        .sort((a, b) =>
            compare(a.bucket + '\0' + a.key, b.bucket + '\0' + b.key)
        )
        .map((row, index) => {
            requireObject(
                state.buckets.includes(row.bucket),
                'inventory-owned-bucket'
            );
            validateKey(row.key, fixture, documentOrganizations);
            requireObject(
                Number.isSafeInteger(row.bytes) &&
                    row.bytes >= 0 &&
                    row.bytes <= LIMITS.objectBytes &&
                    hash.test(row.sha256),
                'inventory-shape'
            );
            total += row.bytes;
            requireObject(total <= LIMITS.totalBytes, 'inventory-total-cap');
            const identity = row.bucket + '\0' + row.key;
            requireObject(!objectMap.has(identity), 'duplicate-object');
            requireObject(
                row.blob ===
                    'object-' + String(index).padStart(4, '0') + '.bin',
                'flat-private-blob'
            );
            const normalized = {
                bucket: row.bucket,
                key: row.key,
                blob: row.blob,
                bytes: row.bytes,
                sha256: row.sha256,
                ...objectHeaders({
                    ContentType: row.headers.contentType,
                    CacheControl: row.headers.cacheControl,
                    ContentDisposition: row.headers.contentDisposition,
                    ContentEncoding: row.headers.contentEncoding,
                    ContentLanguage: row.headers.contentLanguage,
                    Expires:
                        row.headers.expires === null
                            ? null
                            : new Date(row.headers.expires),
                    Metadata: row.metadata,
                }),
            };
            requireObject(
                canonical(normalized) === canonical(row),
                'noncanonical-inventory-fields'
            );
            objectMap.set(identity, normalized);
            return normalized;
        });
    const seen = new Set();
    const references = [...bindings]
        .sort((a, b) => compare(a.kind + '\0' + a.id, b.kind + '\0' + b.id))
        .map((row) => {
            requireObject(
                ['ORIGINAL', 'EXTRACTION'].includes(row.kind) &&
                    identifier.test(row.id) &&
                    fixture.organizationIds.includes(row.organizationId) &&
                    fixture.documentIds.includes(row.documentId),
                'binding-identity'
            );
            requireObject(
                !seen.has(row.kind + '\0' + row.id),
                'duplicate-binding'
            );
            seen.add(row.kind + '\0' + row.id);
            const keyParts = validateKey(
                row.key,
                fixture,
                documentOrganizations
            );
            requireObject(
                uuid.test(row.versionId) &&
                    keyParts[0] === row.organizationId &&
                    keyParts[1] === row.documentId &&
                    keyParts[2] === row.versionId &&
                    (row.kind === 'ORIGINAL'
                        ? row.id === row.versionId && keyParts[3] === 'original'
                        : ['text.txt', 'extraction.json'].includes(
                              keyParts[3]
                          )),
                'exact-version-object-binding'
            );
            requireObject(
                typeof row.requiredPresent === 'boolean' &&
                    ['AVAILABLE', 'DELETING', 'PURGED'].includes(
                        row.contentState
                    ) &&
                    (row.discardedAt === null ||
                        (typeof row.discardedAt === 'string' &&
                            new Date(row.discardedAt).toISOString() ===
                                row.discardedAt)) &&
                    row.requiredPresent ===
                        (row.kind === 'ORIGINAL'
                            ? row.contentState === 'AVAILABLE' &&
                              row.discardedAt === null
                            : row.discardedAt === null) &&
                    (row.expectedContentType === null ||
                        (typeof row.expectedContentType === 'string' &&
                            Buffer.byteLength(row.expectedContentType) <=
                                2048)),
                'binding-presence-policy'
            );
            requireObject(
                Number.isSafeInteger(row.expectedBytes) &&
                    row.expectedBytes >= 0 &&
                    row.expectedBytes <= LIMITS.objectBytes &&
                    ['ORGANIZATION', 'PLATFORM'].includes(
                        row.credentialBinding
                    ),
                'binding-byte-and-policy'
            );
            requireObject(
                row.kind === 'ORIGINAL'
                    ? hash.test(row.catalogSha256)
                    : row.catalogSha256 === null,
                'catalog-hash-policy'
            );
            const destination = {
                endpoint: row.endpoint,
                region: row.region,
                bucket: row.bucket,
                forcePathStyle: row.forcePathStyle,
            };
            requireObject(
                destination.endpoint ===
                    'http://127.0.0.1:' + state.ports.rustfs &&
                    destination.region === 'us-east-1' &&
                    state.buckets.includes(destination.bucket) &&
                    destination.forcePathStyle === true,
                'binding-destination'
            );
            requireObject(
                identifier.test(row.storageLocationId) &&
                    hash.test(row.storageFingerprint) &&
                    (row.credentialId === null ||
                        identifier.test(row.credentialId)),
                'storage-binding-identity'
            );
            requireObject(
                (row.credentialBinding === 'PLATFORM') ===
                    (row.credentialId === null),
                'credential-binding-policy'
            );
            const identity = row.bucket + '\0' + row.key;
            requireObject(
                !locations.has(identity),
                'duplicate-catalog-object-binding'
            );
            locations.set(identity, row);
            const physical = objectMap.get(identity);
            requireObject(
                Boolean(physical) || !row.requiredPresent,
                'required-catalog-object-missing'
            );
            if (physical) {
                requireObject(
                    physical.bytes === row.expectedBytes,
                    'catalog-object-size'
                );
                requireObject(
                    row.catalogSha256 === null ||
                        row.catalogSha256 === physical.sha256,
                    'catalog-original-sha'
                );
                requireObject(
                    physical.headers.contentType === row.expectedContentType,
                    `catalog-object-content-type-${row.kind.toLowerCase()}-expected-${mimeDiagnosticClass(row.expectedContentType)}-actual-${mimeDiagnosticClass(physical.headers.contentType)}`
                );
            }
            return {
                ...row,
                presence: physical ? 'PRESENT' : 'ABSENT_ALLOWED',
                databaseHashState:
                    row.kind === 'ORIGINAL' ? 'KNOWN' : 'NOT_STORED',
            };
        });
    const manifest = {
        formatVersion: 1,
        runId: state.runId,
        prefix: state.prefix,
        buckets: [...state.buckets].sort(),
        documentOrganizations: { ...documentOrganizations },
        bindings: references,
        objects,
        unknowns: {
            missingShaMetadata: objects.filter(
                (row) => row.shaMetadataState === 'MISSING'
            ).length,
            missingContentType: objects.filter(
                (row) => row.headers.contentType === null
            ).length,
            databaseExtractionHashesNotStored: references.filter(
                (row) => row.kind === 'EXTRACTION'
            ).length,
            unreferencedObjects: objects.filter(
                (row) => !locations.has(row.bucket + '\0' + row.key)
            ).length,
            allowedAbsentUnavailableObjects: references.filter(
                (row) => row.presence === 'ABSENT_ALLOWED'
            ).length,
        },
        limits: LIMITS,
        coverage:
            'QUIESCED_CURRENT_OBJECTS_ONLY_NO_VERSION_HISTORY_OR_CLOUD_POLICY_BACKUP',
    };
    return manifest;
}
export function publicManifest(manifest) {
    return {
        formatVersion: 1,
        objects: manifest.objects.length,
        bytes: manifest.objects.reduce((n, row) => n + row.bytes, 0),
        manifestSha256: sha256(canonical(manifest)),
        catalogBindingSha256: sha256(canonical(manifest.bindings)),
        originalBindings: manifest.bindings.filter(
            (row) => row.kind === 'ORIGINAL'
        ).length,
        extractionBindings: manifest.bindings.filter(
            (row) => row.kind === 'EXTRACTION'
        ).length,
        ...manifest.unknowns,
    };
}
