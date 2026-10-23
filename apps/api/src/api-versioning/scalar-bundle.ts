import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

declare const __VECTORIX_PACKAGED_SCALAR__: boolean;

export const SCALAR_VERSION = '1.75.1';
export const MAX_SCALAR_BUNDLE_BYTES = 8 * 1024 * 1024;
export const SCALAR_ASSET_PREFIX = '/_playground/scalar/';
export const SCALAR_PACKAGED_FILE = 'scalar-api-reference.js';

/** A deployment/asset failure with no package path, filesystem error or vendor contents. */
export class ScalarBundleUnavailableError extends Error {
    constructor() {
        super('API playground is unavailable.');
        this.name = 'ScalarBundleUnavailableError';
    }
}

function readBoundedFile(file: URL, maximum: number): Buffer {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(descriptor);
        if (!before.isFile() || before.size <= 0 || before.size > maximum)
            throw new ScalarBundleUnavailableError();
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(
                descriptor,
                bytes,
                offset,
                bytes.length - offset,
                null
            );
            if (count === 0) throw new ScalarBundleUnavailableError();
            offset += count;
        }
        const after = fstatSync(descriptor);
        if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
        )
            throw new ScalarBundleUnavailableError();
        return bytes;
    } catch {
        throw new ScalarBundleUnavailableError();
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

/** Read a regular local bundle at a fixed byte bound without following a leaf symlink. */
export function readScalarBundleFile(file: URL): Buffer {
    return readBoundedFile(file, MAX_SCALAR_BUNDLE_BYTES);
}

/**
 * Build/source-test input only: resolve the declared package entry, rather than
 * an unexported package subpath or the current working directory. The API build
 * emits these unchanged bytes, including their vendor license banner, into dist.
 */
export function readInstalledScalarBundle(): Buffer {
    try {
        const require = createRequire(import.meta.url);
        const entry = pathToFileURL(require.resolve('@scalar/api-reference'));
        const metadata: unknown = JSON.parse(
            readBoundedFile(
                new URL('../package.json', entry),
                32 * 1024
            ).toString('utf8')
        );
        if (
            !metadata ||
            typeof metadata !== 'object' ||
            !('name' in metadata) ||
            metadata.name !== '@scalar/api-reference' ||
            !('version' in metadata) ||
            metadata.version !== SCALAR_VERSION
        )
            throw new ScalarBundleUnavailableError();
        return readScalarBundleFile(new URL('browser/standalone.js', entry));
    } catch {
        throw new ScalarBundleUnavailableError();
    }
}

export type ScalarBundle = Readonly<{
    bytes: Uint8Array<ArrayBuffer>;
    sha256: string;
    etag: string;
    assetPath: string;
    integrity: string;
}>;

type ScalarBundleLoaderOptions = Readonly<{
    packaged: boolean;
    readFile?: (file: URL) => Uint8Array;
    installedSource?: () => Uint8Array;
}>;

/**
 * Construct a lazy, success-cached asset loader. Packaged mode reads only its
 * sibling dist file and never falls back to npm/CDN. The injected boundary is
 * for focused source tests; HTTP input and deployment env cannot select it.
 */
export function createScalarBundleLoader({
    packaged,
    readFile = readScalarBundleFile,
    installedSource = readInstalledScalarBundle,
}: ScalarBundleLoaderOptions): () => ScalarBundle {
    let cached: ScalarBundle | undefined;
    return () => {
        if (cached) return cached;
        try {
            const input = packaged
                ? readFile(new URL('scalar-api-reference.js', import.meta.url))
                : installedSource();
            if (
                !(input instanceof Uint8Array) ||
                input.byteLength === 0 ||
                input.byteLength > MAX_SCALAR_BUNDLE_BYTES
            )
                throw new ScalarBundleUnavailableError();
            const bytes = new Uint8Array(input);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            cached = {
                bytes,
                sha256,
                etag: `"${sha256}"`,
                assetPath: `${SCALAR_ASSET_PREFIX}${sha256}.js`,
                integrity: `sha384-${createHash('sha384').update(bytes).digest('base64')}`,
            };
            return cached;
        } catch {
            throw new ScalarBundleUnavailableError();
        }
    };
}

// Only Vite defines this private constant. Source tests/development use the
// installed devDependency; the compiled production branch cannot use it.
const packaged =
    typeof __VECTORIX_PACKAGED_SCALAR__ === 'boolean' &&
    __VECTORIX_PACKAGED_SCALAR__;

/** Lazy loading keeps an unavailable playground asset from disabling other API routes. */
export const loadScalarBundle = createScalarBundleLoader({ packaged });
