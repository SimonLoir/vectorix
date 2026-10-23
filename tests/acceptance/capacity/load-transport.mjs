/** Guarded adapter factory: core-only imports; never opens files, clients or sockets on import. */
export const RUNTIME_DRAFT_ONLY = true;
export const TRANSPORT_LIMITS = Object.freeze({
    requestBytes: 1024 * 1024,
    responseBytes: 2 * 1024 * 1024,
    requestTotalBytes: 256 * 1024 * 1024,
    responseTotalBytes: 512 * 1024 * 1024,
    calls: 20000,
    importMs: 180 * 60 * 1000,
    requestMs: 40000,
    trafficRequestMs: 65000,
    startsPerSecond: 10,
    inputJsonBytes: 65536,
    cookieBytes: 32768,
});
const READS = new Set([
    'documents.list',
    'documents.get',
    'documents.details',
    'documents.preview',
    'documents.download',
    'collections.list',
    'collections.get',
    'indexing.models',
    'indexing.status',
    'indexing.documents',
    'indexing.tasks',
    'indexing.chunks',
    'indexing.search',
    'indexing.sourcePreview',
    'indexing.sourceOriginal',
]);
const MUTATIONS = new Set([
    'documents.upload',
    'documents.setCollection',
    'collections.create',
    'indexing.probe',
    'indexing.start',
    'indexing.updateMetadata',
]);
const SAFE = new Set([
    'LOAD_CONFIG',
    'LOAD_OPERATION',
    'LOAD_INPUT_CAP',
    'LOAD_REQUEST_CAP',
    'LOAD_RESPONSE_CAP',
    'LOAD_REDIRECT',
    'LOAD_RETRY_REFUSED',
    'LOAD_BUDGET',
    'LOAD_CONCURRENCY',
    'LOAD_RATE',
    'LOAD_AUTH',
    'LOAD_AUTH_IDENTITY',
    'LOAD_COOKIE',
    'LOAD_TIMEOUT',
    'LOAD_CANCELLED',
    'LOAD_TRANSPORT',
    'LOAD_HTTP',
    'LOAD_RPC',
    'LOAD_OBSERVER',
    'LOAD_SESSION_BUSY',
]);
export class LoadTransportError extends Error {
    constructor(code, { status = null, acceptance = 'NOT_SENT' } = {}) {
        super(SAFE.has(code) ? code : 'LOAD_TRANSPORT');
        this.code = this.message;
        this.status =
            Number.isInteger(status) && status >= 100 && status <= 599
                ? status
                : null;
        this.acceptance = [
            'NOT_SENT',
            'REJECTED',
            'UNKNOWN',
            'NOT_APPLICABLE',
        ].includes(acceptance)
            ? acceptance
            : 'UNKNOWN';
    }
}
const need = (value, code) => {
    if (!value) throw new LoadTransportError(code);
};
const cancel = (body) => {
    try {
        Promise.resolve(body?.cancel()).catch(() => {});
    } catch {
        /* Preserve finite refusal. */
    }
};
const clock = (value) => Number.isFinite(value) && value >= 0;
const safeId = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);

/** Exact separate load namespace and same-host auth origins; no quality/restore state is accepted. */
export function validateLoadTransportState(state, fixture) {
    need(
        state?.namespace === 'vectorix-m7c-load' &&
            /^[a-f0-9]{12}$/u.test(state.runId) &&
            state.prefix === `vectorix-m7c-load-${state.runId}` &&
            fixture?.schemaVersion === 1 &&
            fixture.namespace === state.namespace &&
            fixture.runId === state.runId,
        'LOAD_CONFIG'
    );
    need(
        Object.keys(fixture.users ?? {})
            .sort()
            .join(',') === 'foreign,owner,reader' &&
            fixture.organizationIds?.length === 2 &&
            new Set(fixture.organizationIds).size === 2 &&
            fixture.organizationIds.every(safeId),
        'LOAD_CONFIG'
    );
    for (const role of ['owner', 'reader', 'foreign']) {
        const user = fixture.users[role];
        need(
            safeId(user.userId) &&
                safeId(user.memberId) &&
                fixture.organizationIds.includes(user.organizationId) &&
                user.email === `m7c-load-${role}-${state.runId}@example.test` &&
                typeof user.password === 'string' &&
                user.password.length >= 20 &&
                user.password.length <= 200,
            'LOAD_CONFIG'
        );
    }
    need(
        new Set(Object.values(fixture.users).map((user) => user.userId))
            .size === 3 &&
            fixture.users.owner.organizationId ===
                fixture.users.reader.organizationId &&
            fixture.users.owner.organizationId !==
                fixture.users.foreign.organizationId,
        'LOAD_CONFIG'
    );
    need(
        Number.isInteger(state.ports?.api) &&
            Number.isInteger(state.ports.web) &&
            state.ports.api > 1024 &&
            state.ports.api < 65536 &&
            state.ports.web > 1024 &&
            state.ports.web < 65536 &&
            state.ports.api !== state.ports.web &&
            state.apiOrigin === `http://127.0.0.1:${state.ports.api}` &&
            state.webOrigin === `http://127.0.0.1:${state.ports.web}` &&
            state.environment?.BETTER_AUTH_URL === state.apiOrigin &&
            state.environment.API_URL === state.apiOrigin &&
            state.environment.VECTORIX_WEB_URL === state.webOrigin &&
            state.environment.TRUSTED_ORIGINS === state.webOrigin,
        'LOAD_CONFIG'
    );
    return state;
}

/** Count actual stream bytes; an abort cannot be held hostage by a nonsettling read/cancel. */
export async function readLoadBytes(body, maximum, signal) {
    need(
        !signal?.aborted,
        signal?.reason?.name === 'TimeoutError'
            ? 'LOAD_TIMEOUT'
            : 'LOAD_CANCELLED'
    );
    need(
        Number.isSafeInteger(maximum) &&
            maximum >= 0 &&
            maximum <= TRANSPORT_LIMITS.responseBytes,
        'LOAD_INPUT_CAP'
    );
    const reader = body?.getReader();
    if (!reader) return new Uint8Array(0);
    let listener;
    const aborted = new Promise((_, reject) => {
        listener = () =>
            reject(
                new LoadTransportError(
                    signal?.reason?.name === 'TimeoutError'
                        ? 'LOAD_TIMEOUT'
                        : 'LOAD_CANCELLED'
                )
            );
        if (signal?.aborted) listener();
        else signal?.addEventListener('abort', listener, { once: true });
    });
    try {
        let buffer = new Uint8Array(0),
            used = 0;
        if (reader)
            while (true) {
                const part = await Promise.race([reader.read(), aborted]);
                if (part.done) break;
                need(
                    part.value instanceof Uint8Array &&
                        part.value.byteLength <= maximum - used,
                    'LOAD_RESPONSE_CAP'
                );
                const next = used + part.value.byteLength;
                if (next > buffer.length) {
                    const grown = new Uint8Array(
                        Math.min(
                            maximum,
                            Math.max(65536, next, buffer.length * 2)
                        )
                    );
                    grown.set(buffer.subarray(0, used));
                    buffer = grown;
                }
                buffer.set(part.value, used);
                used = next;
            }
        return buffer.subarray(0, used);
    } finally {
        signal?.removeEventListener('abort', listener);
        if (reader) {
            try {
                Promise.resolve(reader.cancel()).catch(() => {});
            } catch {}
            try {
                reader.releaseLock();
            } catch {}
        } else cancel(body);
    }
}
function cookiesInto(jar, headers) {
    const values = headers.getSetCookie();
    need(
        values.length <= 16 &&
            values.reduce((n, value) => n + value.length, 0) <=
                TRANSPORT_LIMITS.cookieBytes,
        'LOAD_COOKIE'
    );
    for (const value of values) {
        const pair = value.split(';', 1)[0],
            i = pair.indexOf('=');
        need(
            i > 0 &&
                i < 128 &&
                pair.length <= 8192 &&
                /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(pair.slice(0, i)) &&
                !/[\x00-\x20\x7f]/u.test(pair),
            'LOAD_COOKIE'
        );
        const name = pair.slice(0, i),
            token = pair.slice(i + 1);
        need(jar.has(name) || jar.size < 16, 'LOAD_COOKIE');
        if (token) jar.set(name, token);
        else jar.delete(name);
    }
}
function checkInput(operation, input) {
    try {
        let fileBytes = 0;
        const encoded = JSON.stringify(input, (_key, value) => {
            if (value instanceof File) {
                need(
                    value.size > 0 &&
                        value.size <= TRANSPORT_LIMITS.requestBytes &&
                        /^[A-Za-z0-9_.-]{1,160}$/u.test(value.name),
                    'LOAD_INPUT_CAP'
                );
                fileBytes += value.size;
                return { name: value.name, size: value.size, type: value.type };
            }
            return value;
        });
        need(
            typeof encoded === 'string' &&
                Buffer.byteLength(encoded) <= TRANSPORT_LIMITS.inputJsonBytes &&
                fileBytes <= TRANSPORT_LIMITS.requestBytes,
            'LOAD_INPUT_CAP'
        );
        need(
            operation !== 'documents.upload' || input?.file instanceof File,
            'LOAD_INPUT_CAP'
        );
    } catch (error) {
        throw new LoadTransportError(
            error instanceof LoadTransportError ? error.code : 'LOAD_INPUT_CAP'
        );
    }
}

/**
 * Inject the normal oRPC SDK factory in a later reviewed runtime. One client/fetch closure per call
 * binds status and monotonic body timing to that request; no role-global response state or retry exists.
 */
export function createLoadTransport({
    state,
    fixture,
    fetchImpl,
    rpcFactory,
    now = () => performance.now(),
    sleep,
    mode = 'IMPORT',
    onEvent = () => {},
}) {
    validateLoadTransportState(state, fixture);
    need(
        typeof fetchImpl === 'function' &&
            typeof rpcFactory === 'function' &&
            typeof now === 'function' &&
            typeof onEvent === 'function' &&
            ['IMPORT', 'TRAFFIC'].includes(mode) &&
            (mode !== 'IMPORT' || typeof sleep === 'function'),
        'LOAD_CONFIG'
    );
    const jars = new Map(
            ['owner', 'reader', 'foreign'].map((role) => [role, new Map()])
        ),
        signed = new Set(),
        active = new Map(),
        starts = [];
    let calls = 0,
        rpcCalls = 0,
        authCalls = 0,
        requestBytes = 0,
        responseBytes = 0,
        closed = false,
        authBusy = false,
        reserveBusy = false,
        signing = false,
        last = now();
    const beginning = last;
    need(clock(last), 'LOAD_CONFIG');
    const time = () => {
        const value = now();
        need(clock(value) && value >= last, 'LOAD_BUDGET');
        last = value;
        return value;
    };
    const headers = (role) => ({
        origin: state.webOrigin,
        cookie: [...jars.get(role)]
            .map(([key, value]) => key + '=' + value)
            .join('; '),
    });
    function emit(event) {
        try {
            const returned = onEvent(Object.freeze(event));
            if (
                returned !== null &&
                ['object', 'function'].includes(typeof returned) &&
                'then' in returned
            ) {
                Promise.resolve(returned).catch(() => {});
                throw new LoadTransportError('LOAD_OBSERVER');
            }
        } catch {
            throw new LoadTransportError('LOAD_OBSERVER');
        }
    }
    async function reserve(role, operation, isAuth) {
        need(
            !closed &&
                jars.has(role) &&
                time() - beginning <=
                    (mode === 'IMPORT' ? TRANSPORT_LIMITS.importMs : 300000),
            'LOAD_BUDGET'
        );
        need(
            isAuth
                ? authCalls < 12
                : rpcCalls <
                      (mode === 'IMPORT' ? TRANSPORT_LIMITS.calls : 10000),
            'LOAD_BUDGET'
        );
        need(
            !authBusy &&
                !reserveBusy &&
                (isAuth ? active.size === 0 : signed.has(role)),
            'LOAD_SESSION_BUSY'
        );
        reserveBusy = true;
        try {
            if (mode === 'IMPORT') {
                need(active.size === 0, 'LOAD_CONCURRENCY');
            }
            need(!closed && !authBusy, 'LOAD_SESSION_BUSY');
            const count = [...active.values()].filter(
                (value) =>
                    fixture.users[value.role].organizationId ===
                    fixture.users[role].organizationId
            ).length;
            need(
                active.size < (mode === 'IMPORT' ? 1 : 10) &&
                    count < (mode === 'IMPORT' ? 1 : 5),
                'LOAD_CONCURRENCY'
            );
            calls++;
            if (isAuth) authCalls++;
            else rpcCalls++;
            const id = `${state.runId}-${calls}`;
            active.set(id, { role, operation });
            if (isAuth) authBusy = true;
            return id;
        } finally {
            reserveBusy = false;
        }
    }
    async function execute(role, operation, input, isAuth = false) {
        need(
            (isAuth
                ? [
                      'sign-in/email',
                      'organization/set-active',
                      'get-session',
                      'sign-out',
                  ].includes(operation)
                : READS.has(operation) || MUTATIONS.has(operation)) &&
                (role !== 'reader' || isAuth || READS.has(operation)),
            'LOAD_OPERATION'
        );
        if (!isAuth) checkInput(operation, input);
        const id = await reserve(role, operation, isAuth),
            controller = new AbortController();
        let timer,
            fetches = 0,
            status = null,
            dispatched = false,
            bodyRead = null,
            fetchStarted = null,
            bytes = 0;
        const mutation = !isAuth && MUTATIONS.has(operation);
        const timeout =
            mode === 'TRAFFIC'
                ? TRANSPORT_LIMITS.trafficRequestMs
                : TRANSPORT_LIMITS.requestMs;
        timer = setTimeout(
            () =>
                controller.abort(new DOMException('Deadline', 'TimeoutError')),
            timeout
        );
        timer.unref?.();
        let abortListener;
        const aborted = new Promise((_, reject) => {
            abortListener = () =>
                reject(new LoadTransportError('LOAD_TIMEOUT'));
            controller.signal.addEventListener('abort', abortListener, {
                once: true,
            });
        });
        const boundedFetch = async (request, init) => {
            need(++fetches === 1, 'LOAD_RETRY_REFUSED');
            const original =
                    request instanceof Request
                        ? request
                        : new Request(request, init),
                url = new URL(original.url);
            const path = isAuth
                ? '/api/auth/' + operation
                : '/rpc/v1/admin/rag/' + operation.replace('.', '/');
            need(
                url.origin === state.apiOrigin &&
                    url.pathname === path &&
                    !url.search &&
                    !url.hash &&
                    original.method ===
                        (operation === 'get-session' ? 'GET' : 'POST'),
                'LOAD_OPERATION'
            );
            const outgoing = await readLoadBytes(
                original.body,
                TRANSPORT_LIMITS.requestBytes,
                controller.signal
            );
            need(
                requestBytes + outgoing.byteLength <=
                    TRANSPORT_LIMITS.requestTotalBytes,
                'LOAD_BUDGET'
            );
            requestBytes += outgoing.byteLength;
            const signal = AbortSignal.any([
                controller.signal,
                original.signal,
            ]);
            need(!controller.signal.aborted, 'LOAD_CANCELLED');
            const nextHeaders = new Headers(original.headers);
            nextHeaders.delete('content-length');
            nextHeaders.set('origin', state.webOrigin);
            nextHeaders.set('cookie', headers(role).cookie);
            const next = new Request(original, {
                headers: nextHeaders,
                redirect: 'manual',
                signal,
                ...(original.method === 'GET'
                    ? {}
                    : { body: outgoing, duplex: 'half' }),
            });
            // SDK serialization and bounded body reads precede the actual HTTP start gate.
            if (mode === 'IMPORT') {
                // Node timers can wake before a fractional performance.now() deadline. Recheck the
                // monotonic clock after each rounded wait; this is local pacing, never an HTTP retry.
                while (starts.length) {
                    need(!signal.aborted, 'LOAD_CANCELLED');
                    const before = time();
                    need(
                        before - beginning <= TRANSPORT_LIMITS.importMs,
                        'LOAD_BUDGET'
                    );
                    const remaining = 100 - (before - starts.at(-1));
                    if (remaining <= 0) break;
                    await Promise.race([sleep(Math.ceil(remaining)), aborted]);
                    // A broken injected clock/sleeper must fail rather than spin a microtask loop.
                    need(time() > before, 'LOAD_BUDGET');
                }
                need(!signal.aborted, 'LOAD_CANCELLED');
                const at = time();
                while (starts.length && starts[0] <= at - 1000) starts.shift();
                need(
                    (!starts.length || at - starts.at(-1) >= 100) &&
                        starts.length < TRANSPORT_LIMITS.startsPerSecond,
                    'LOAD_RATE'
                );
                starts.push(at);
            }
            need(
                time() - beginning <=
                    (mode === 'IMPORT' ? TRANSPORT_LIMITS.importMs : 300000),
                'LOAD_BUDGET'
            );
            fetchStarted = time();
            emit({
                type: 'BEGIN',
                id,
                role,
                operation,
                atMicros: Math.round(fetchStarted * 1000),
            });
            dispatched = true;
            const response = await fetchImpl(next);
            status = response.status;
            need(
                Number.isInteger(status) && status >= 100 && status <= 599,
                'LOAD_HTTP'
            );
            if (status >= 300 && status < 400) {
                cancel(response.body);
                throw new LoadTransportError('LOAD_REDIRECT');
            }
            const length = response.headers.get('content-length');
            if (
                length !== null &&
                !(
                    /^\d+$/u.test(length) &&
                    Number(length) <= TRANSPORT_LIMITS.responseBytes
                )
            ) {
                cancel(response.body);
                throw new LoadTransportError('LOAD_RESPONSE_CAP');
            }
            const data = await readLoadBytes(
                response.body,
                TRANSPORT_LIMITS.responseBytes,
                signal
            );
            bytes = data.byteLength;
            need(
                responseBytes + bytes <= TRANSPORT_LIMITS.responseTotalBytes,
                'LOAD_BUDGET'
            );
            responseBytes += bytes;
            bodyRead = time();
            emit({
                type: 'BODY',
                id,
                role,
                operation,
                atMicros: Math.round(bodyRead * 1000),
                status,
                responseBytes: bytes,
            });
            const replayHeaders = new Headers(response.headers);
            replayHeaders.delete('content-encoding');
            replayHeaders.delete('content-length');
            return new Response(
                [204, 205, 304].includes(status) ? null : data,
                { status, headers: replayHeaders }
            );
        };
        try {
            const invoke = async () => {
                let value;
                if (isAuth) {
                    const response = await boundedFetch(
                        new Request(
                            state.apiOrigin + '/api/auth/' + operation,
                            {
                                method:
                                    operation === 'get-session'
                                        ? 'GET'
                                        : 'POST',
                                headers: {
                                    ...headers(role),
                                    'content-type': 'application/json',
                                },
                                ...(operation === 'get-session'
                                    ? {}
                                    : { body: JSON.stringify(input) }),
                            }
                        )
                    );
                    need(response.ok, 'LOAD_HTTP');
                    cookiesInto(jars.get(role), response.headers);
                    value = await response.json();
                } else {
                    const client = rpcFactory({
                        url: state.apiOrigin + '/rpc/v1',
                        headers: () => headers(role),
                        fetch: boundedFetch,
                    });
                    const [section, action] = operation.split('.');
                    value = await client.admin.rag[section][action](input);
                }
                return value;
            };
            const value = await Promise.race([
                Promise.resolve().then(invoke),
                aborted,
            ]);
            need(
                fetches === 1 &&
                    status === 200 &&
                    fetchStarted !== null &&
                    bodyRead !== null,
                'LOAD_RPC'
            );
            const ended = time();
            return Object.freeze({
                value,
                http: Object.freeze({
                    requestId: id,
                    status,
                    responseBytes: bytes,
                    startedMicros: Math.round(fetchStarted * 1000),
                    bodyReadMicros: Math.round(bodyRead * 1000),
                    endedMicros: Math.round(ended * 1000),
                }),
            });
        } catch (error) {
            const code = controller.signal.aborted
                ? 'LOAD_TIMEOUT'
                : error instanceof LoadTransportError
                  ? error.code
                  : status === 401 || status === 403
                    ? 'LOAD_AUTH'
                    : status === 429
                      ? 'LOAD_HTTP'
                      : dispatched
                        ? 'LOAD_RPC'
                        : 'LOAD_TRANSPORT';
            throw new LoadTransportError(code, {
                status,
                acceptance: !mutation
                    ? 'NOT_APPLICABLE'
                    : !dispatched
                      ? 'NOT_SENT'
                      : 'UNKNOWN',
            });
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abortListener);
            controller.abort();
            active.delete(id);
            if (isAuth) authBusy = false;
            try {
                emit({
                    type: 'END',
                    id,
                    role,
                    operation,
                    atMicros: Math.round(time() * 1000),
                    status,
                });
            } catch {
                throw new LoadTransportError('LOAD_OBSERVER', {
                    status,
                    acceptance: !mutation
                        ? 'NOT_APPLICABLE'
                        : !dispatched
                          ? 'NOT_SENT'
                          : 'UNKNOWN',
                });
            }
        }
    }
    return {
        async signIn() {
            need(
                !signing && active.size === 0 && !reserveBusy,
                'LOAD_SESSION_BUSY'
            );
            signing = true;
            try {
                for (const [role, user] of Object.entries(fixture.users)) {
                    const value = (
                        await execute(
                            role,
                            'sign-in/email',
                            { email: user.email, password: user.password },
                            true
                        )
                    ).value;
                    need(
                        value?.user?.id === user.userId &&
                            value.user.email === user.email,
                        'LOAD_AUTH_IDENTITY'
                    );
                    await execute(
                        role,
                        'organization/set-active',
                        { organizationId: user.organizationId },
                        true
                    );
                    const current = (
                        await execute(role, 'get-session', undefined, true)
                    ).value;
                    need(
                        current?.user?.id === user.userId &&
                            current.session?.activeOrganizationId ===
                                user.organizationId,
                        'LOAD_AUTH_IDENTITY'
                    );
                    signed.add(role);
                }
            } catch (error) {
                signed.clear();
                for (const jar of jars.values()) jar.clear();
                throw error;
            } finally {
                signing = false;
            }
        },
        call: (role, operation, input) => {
            need(!signing, 'LOAD_SESSION_BUSY');
            return execute(role, operation, input);
        },
        counters: () =>
            Object.freeze({
                calls,
                rpcCalls,
                authCalls,
                requestBytes,
                responseBytes,
                active: active.size,
            }),
        close() {
            need(
                active.size === 0 && !reserveBusy && !signing,
                'LOAD_SESSION_BUSY'
            );
            closed = true;
            signed.clear();
            for (const jar of jars.values()) jar.clear();
        },
    };
}
