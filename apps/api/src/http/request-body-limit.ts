import type { Context, MiddlewareHandler } from 'hono';
import type { ApiVersionDefinition } from '../api-versioning/registry';
import { withApiVersionHeaders } from '../api-versioning/headers';

export const DEFAULT_REQUEST_BODY_BYTES = 1024 * 1024;
export const DOCUMENT_REQUEST_BODY_BYTES = 26 * 1024 * 1024;

type TransportPaths = Pick<ApiVersionDefinition, 'rpcPath' | 'restPath'>;
type LimitVersion = TransportPaths &
    Pick<ApiVersionDefinition, 'major' | 'revision' | 'status'>;
type BodyReadResult =
    { ok: true; bytes: Uint8Array | null } | { ok: false; status: 400 | 413 };

/**
 * Grant the document allowance only to POSTs on the four canonical app-visible
 * transport paths. Do not decode aliases or extend the allowance to subpaths.
 */
export function requestBodyByteLimit(
    method: string,
    pathname: string,
    versions: readonly TransportPaths[]
) {
    if (method !== 'POST') return DEFAULT_REQUEST_BODY_BYTES;
    for (const version of versions) {
        if (
            pathname === `${version.rpcPath}/admin/rag/documents/upload` ||
            pathname === `${version.rpcPath}/admin/rag/documents/replace` ||
            pathname === `${version.restPath}/admin/rag/documents/uploads`
        )
            return DOCUMENT_REQUEST_BODY_BYTES;
        const prefix = `${version.restPath}/admin/rag/documents/`;
        const suffix = '/replacements';
        if (pathname.startsWith(prefix) && pathname.endsWith(suffix)) {
            const id = pathname.slice(prefix.length, -suffix.length);
            if (/^[A-Za-z0-9._~-]{1,128}$/.test(id))
                return DOCUMENT_REQUEST_BODY_BYTES;
        }
    }
    return DEFAULT_REQUEST_BODY_BYTES;
}

/** Initiate cancellation without waiting for an unbounded network/user cancellation hook. */
function cancelBody(body: ReadableStream<Uint8Array> | null) {
    if (body) void body.cancel().catch(() => {});
}

function hasOversizedDeclaration(headers: Headers, limit: number) {
    const declared = headers.get('content-length');
    return (
        declared !== null && /^\d+$/.test(declared) && Number(declared) > limit
    );
}

/**
 * Inspect every exposed byte before any parser runs. A growing contiguous buffer
 * bounds retained storage without retaining one allocation per tiny input chunk.
 * Content-Length is an early-rejection hint, never proof that a body fits.
 */
async function readBody(
    request: Request,
    limit: number
): Promise<BodyReadResult> {
    if (hasOversizedDeclaration(request.headers, limit)) {
        cancelBody(request.body);
        return { ok: false, status: 413 };
    }
    const body = request.body;
    if (!body) return { ok: true, bytes: null };
    const reader = body.getReader();
    let cancelled = false;
    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        void reader.cancel().catch(() => {});
    };
    const signal = request.signal;
    const abort = () => cancel();
    signal.addEventListener('abort', abort, { once: true });
    let bytes = new Uint8Array(0);
    let size = 0;
    try {
        if (signal.aborted) {
            cancel();
            return { ok: false, status: 400 };
        }
        while (true) {
            const item = await reader.read();
            if (signal.aborted) {
                cancel();
                return { ok: false, status: 400 };
            }
            if (item.done) return { ok: true, bytes: bytes.subarray(0, size) };
            if (!(item.value instanceof Uint8Array)) {
                cancel();
                return { ok: false, status: 400 };
            }
            const nextSize = size + item.value.byteLength;
            if (nextSize > limit) {
                cancel();
                return { ok: false, status: 413 };
            }
            if (nextSize > bytes.byteLength) {
                const capacity = Math.min(
                    limit,
                    Math.max(nextSize, bytes.byteLength * 2, 64 * 1024)
                );
                const expanded = new Uint8Array(capacity);
                expanded.set(bytes.subarray(0, size));
                bytes = expanded;
            }
            bytes.set(item.value, size);
            size = nextSize;
        }
    } catch {
        cancel();
        return { ok: false, status: 400 };
    } finally {
        signal.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}

function hasPrefix(pathname: string, prefix: string) {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function bodyError(
    context: Context,
    pathname: string,
    versions: readonly LimitVersion[],
    status: 400 | 413
) {
    const version = versions.find(
        (entry) =>
            hasPrefix(pathname, entry.rpcPath) ||
            hasPrefix(pathname, entry.restPath)
    );
    const error = {
        defined: false,
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        status,
        message:
            status === 413
                ? 'Request body exceeds the allowed size.'
                : 'Request body could not be read.',
    };
    const rpc = version && hasPrefix(pathname, version.rpcPath);
    const response = context.json(rpc ? { json: error } : error, status);
    return version ? withApiVersionHeaders(response, version) : response;
}

/**
 * Run after CORS and before auth/oRPC. Preserve preflight handling and bodyless
 * requests; only streams exposed by the Fetch adapter can be counted. Rebuild
 * accepted requests byte-for-byte, retaining headers, URL, method and signal.
 */
export function requestBodyLimit(
    versions: readonly LimitVersion[]
): MiddlewareHandler {
    return async (context, next) => {
        const request = context.req.raw;
        const pathname = new URL(request.url).pathname;
        const limit = requestBodyByteLimit(request.method, pathname, versions);
        try {
            const result = await readBody(request, limit);
            if (!result.ok)
                return bodyError(context, pathname, versions, result.status);
            if (result.bytes !== null) {
                const bytes = result.bytes;
                const init = {
                    body: new ReadableStream<Uint8Array>({
                        start(controller) {
                            if (bytes.byteLength) controller.enqueue(bytes);
                            controller.close();
                        },
                    }),
                    signal: request.signal,
                    duplex: 'half',
                };
                context.req.raw = new Request(request, init);
            }
        } catch {
            return bodyError(context, pathname, versions, 400);
        }
        await next();
    };
}
