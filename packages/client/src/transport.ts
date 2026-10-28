import { VectorixClientError } from './errors';
import {
    VECTORIX_SUPPORTED_API_MAJOR,
    VECTORIX_MIN_API_REVISION,
    VECTORIX_MAX_RESPONSE_BYTES,
    type ClientConfiguration,
} from './configuration';

/** Cancel best effort without awaiting a peer-controlled cancellation hook. */
function discard(response: Response) {
    void response.body?.cancel().catch(() => {});
}

/** A compatible revision may add fields; another major or an older retrieval baseline is never silently accepted. */
function checkVersion(response: Response) {
    if (
        response.headers.get('Vectorix-API-Version') !==
        String(VECTORIX_SUPPORTED_API_MAJOR)
    )
        throw new VectorixClientError('UNSUPPORTED_API_VERSION');
    const revision = response.headers.get('Vectorix-API-Revision');
    if (revision === null || !/^(?:0|[1-9]\d{0,8})$/u.test(revision))
        throw new VectorixClientError('UNSUPPORTED_API_REVISION');
    if (Number(revision) < VECTORIX_MIN_API_REVISION)
        throw new VectorixClientError('UNSUPPORTED_API_REVISION');
}

/** Count actual exposed bytes with bounded contiguous storage, including dishonest Content-Length responses. */
async function bufferResponse(response: Response, signal: AbortSignal) {
    const declared = response.headers.get('content-length');
    if (
        declared !== null &&
        (!/^\d+$/u.test(declared) ||
            Number(declared) > VECTORIX_MAX_RESPONSE_BYTES)
    )
        throw new VectorixClientError('RESPONSE_TOO_LARGE');
    if (!response.body) return response;
    const reader = response.body.getReader();
    const abort = () => {
        void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    let bytes = new Uint8Array(0),
        size = 0;
    try {
        if (signal.aborted) throw new VectorixClientError('ABORTED');
        for (;;) {
            const item = await reader.read();
            if (signal.aborted) throw new VectorixClientError('ABORTED');
            if (item.done) break;
            const next = size + item.value.byteLength;
            if (next > VECTORIX_MAX_RESPONSE_BYTES)
                throw new VectorixClientError('RESPONSE_TOO_LARGE');
            if (next > bytes.byteLength) {
                const expanded = new Uint8Array(
                    Math.min(
                        VECTORIX_MAX_RESPONSE_BYTES,
                        Math.max(next, bytes.byteLength * 2, 65_536)
                    )
                );
                expanded.set(bytes.subarray(0, size));
                bytes = expanded;
            }
            bytes.set(item.value, size);
            size = next;
        }
        return new Response(bytes.subarray(0, size), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } finally {
        signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/** Attach only the explicitly configured key/tenant to the fixed origin and refuse every redirect. */
export function securedFetch(configuration: ClientConfiguration) {
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (
            url.origin !== configuration.origin ||
            !url.pathname.startsWith('/rpc/v1/')
        )
            throw new VectorixClientError('INVALID_CONFIGURATION');
        if (request.signal.aborted) throw new VectorixClientError('ABORTED');
        const headers = new Headers(request.headers);
        for (const [name, value] of configuration.headers)
            headers.set(name, value);
        headers.delete('cookie');
        headers.delete('authorization');
        const outgoing = new Request(request, {
            headers,
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
        });
        let response: Response;
        try {
            response = await configuration.fetcher(outgoing);
        } catch {
            throw new VectorixClientError('NETWORK_ERROR');
        }
        try {
            if (outgoing.signal.aborted)
                throw new VectorixClientError('ABORTED');
            if (
                response.redirected ||
                response.type === 'opaqueredirect' ||
                (response.status >= 300 && response.status < 400)
            )
                throw new VectorixClientError('REDIRECT_REFUSED');
            checkVersion(response);
            return await bufferResponse(response, outgoing.signal);
        } catch (error) {
            discard(response);
            throw error;
        }
    };
}

/**
 * Race even an uncooperative injected fetch, while aborting its real signal.
 * The trusted override remains responsible for stopping its own underlying I/O.
 */
export async function withDeadline<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    external?: AbortSignal
): Promise<T> {
    if (external?.aborted) throw new VectorixClientError('ABORTED');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = () =>
            reject(new VectorixClientError(timedOut ? 'TIMEOUT' : 'ABORTED'));
        controller.signal.addEventListener('abort', rejectAborted, {
            once: true,
        });
    });
    try {
        return await Promise.race([run(controller.signal), aborted]);
    } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', rejectAborted);
    }
}
