import { lookup, type LookupAddress } from 'node:dns';
import { Agent, request, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { LookupFunction } from 'node:net';
import webPush from 'web-push';
import {
    admitPushEndpoint,
    createPushEndpointPolicy,
    type AdmittedPushEndpoint,
} from '@routers/utils/push-endpoint-policy';
import {
    publicPushAddressAnswers,
    type PublicPushAddress,
} from './push-address-policy';

export const PUSH_DNS_TIMEOUT_MS = 5000;
export const PUSH_TOTAL_TIMEOUT_MS = 10_000;
export const MAX_PUSH_RESPONSE_BYTES = 16 * 1024;
export const MAX_PUSH_HEADER_BYTES = 16 * 1024;

type PushTransportReason =
    | 'INVALID_TARGET'
    | 'INVALID_REQUEST'
    | 'DNS_FAILURE'
    | 'DNS_BLOCKED'
    | 'DNS_TIMEOUT'
    | 'TOTAL_TIMEOUT'
    | 'RESPONSE_LIMIT'
    | 'INVALID_RESPONSE'
    | 'NETWORK';

/** Static categories only; no destination, DNS answer, provider text or raw cause. */
export class PushTransportError extends Error {
    readonly code: 'ENOTFOUND' | 'ETIMEDOUT' | 'ECONNRESET';
    constructor(readonly reason: PushTransportReason) {
        super('Web Push transport failed');
        this.code = reason.endsWith('TIMEOUT')
            ? 'ETIMEDOUT'
            : reason.startsWith('DNS') || reason === 'INVALID_TARGET'
              ? 'ENOTFOUND'
              : 'ECONNRESET';
    }
}

type PushLookupAll = (
    hostname: string,
    callback: (
        error: NodeJS.ErrnoException | null,
        addresses: LookupAddress[]
    ) => void
) => void;

/** Minimal native request surface also used by explicitly controlled transport tests. */
export type PushHttpResponse = {
    statusCode?: number;
    headers: IncomingHttpHeaders;
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    once(event: 'end' | 'aborted', listener: () => void): unknown;
    once(event: 'error', listener: (error: unknown) => void): unknown;
    destroy(error?: Error): unknown;
};
export type PushHttpRequest = {
    once(event: 'error', listener: (error: unknown) => void): unknown;
    end(body?: Uint8Array): unknown;
    destroy(error?: Error): unknown;
};
export type PushRequestFactory = (
    options: RequestOptions,
    callback: (response: PushHttpResponse) => void
) => PushHttpRequest;

type PushTransportDependencies = Readonly<{
    lookupAll?: PushLookupAll;
    request?: PushRequestFactory;
}>;
type PushOptions = Pick<
    webPush.RequestOptions,
    'TTL' | 'urgency' | 'vapidDetails'
>;

const systemLookup: PushLookupAll = (hostname, callback) =>
    lookup(
        hostname,
        { all: true, family: 0, hints: 0, order: 'verbatim' },
        callback
    );

function pinnedLookup(
    hostname: string,
    deadline: number,
    resolve: PushLookupAll
) {
    let closed = false;
    let resolution: Promise<readonly PublicPushAddress[]> | undefined;
    let cancel: (() => void) | undefined;
    const getAnswers = () =>
        (resolution ??= new Promise((accept, reject) => {
            let settled = false;
            const finish = (
                error: PushTransportError | null,
                answers?: readonly PublicPushAddress[]
            ) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else if (answers) accept(answers);
            };
            const timer = setTimeout(
                () => finish(new PushTransportError('DNS_TIMEOUT')),
                Math.max(
                    1,
                    Math.min(PUSH_DNS_TIMEOUT_MS, deadline - performance.now())
                )
            );
            cancel = () => finish(new PushTransportError('NETWORK'));
            try {
                resolve(hostname, (error, answers) => {
                    if (settled) return;
                    if (closed || performance.now() >= deadline)
                        return finish(new PushTransportError('TOTAL_TIMEOUT'));
                    const approved = error
                        ? null
                        : publicPushAddressAnswers(answers);
                    finish(
                        error
                            ? new PushTransportError('DNS_FAILURE')
                            : approved
                              ? null
                              : new PushTransportError('DNS_BLOCKED'),
                        approved ?? undefined
                    );
                });
            } catch {
                finish(new PushTransportError('DNS_FAILURE'));
            }
        }));
    const lookupPinned: LookupFunction = (name, options, callback) => {
        if (closed || name !== hostname || performance.now() >= deadline) {
            callback(
                new PushTransportError(
                    performance.now() >= deadline
                        ? 'TOTAL_TIMEOUT'
                        : 'INVALID_TARGET'
                ),
                '',
                0
            );
            return;
        }
        void getAnswers().then(
            (answers) => {
                if (closed || performance.now() >= deadline) {
                    callback(new PushTransportError('TOTAL_TIMEOUT'), '', 0);
                    return;
                }
                const family =
                    options.family === 'IPv4'
                        ? 4
                        : options.family === 'IPv6'
                          ? 6
                          : options.family;
                const selected = answers.filter(
                    (answer) => !family || answer.family === family
                );
                if (!selected.length) {
                    callback(new PushTransportError('DNS_FAILURE'), '', 0);
                } else if (options.all) {
                    callback(
                        null,
                        selected.map((answer) => ({ ...answer }))
                    );
                } else {
                    callback(null, selected[0]!.address, selected[0]!.family);
                }
            },
            (error: unknown) =>
                callback(
                    error instanceof PushTransportError
                        ? error
                        : new PushTransportError('DNS_FAILURE'),
                    '',
                    0
                )
        );
    };
    return {
        lookup: lookupPinned,
        close() {
            closed = true;
            cancel?.();
        },
    };
}

function responseHeaders(headers: IncomingHttpHeaders): webPush.Headers {
    const result: webPush.Headers = {};
    let bytes = 0;
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        const text = Array.isArray(value) ? value.join(', ') : value;
        bytes += Buffer.byteLength(key) + Buffer.byteLength(text) + 4;
        if (bytes > MAX_PUSH_HEADER_BYTES)
            throw new PushTransportError('RESPONSE_LIMIT');
        result[key] = text;
    }
    return result;
}

/** Reconstruct metadata so even a forged internal target cannot bypass DNS via an IP literal. */
function checkedTarget(
    endpoint: string,
    admitted: AdmittedPushEndpoint
): AdmittedPushEndpoint {
    try {
        const target = admitPushEndpoint(
            endpoint,
            createPushEndpointPolicy(admitted.origin)
        );
        if (
            target &&
            target.endpoint === admitted.endpoint &&
            target.hostname === admitted.hostname &&
            target.origin === admitted.origin &&
            target.requestPath === admitted.requestPath
        )
            return target;
    } catch {
        // Never expose parsing errors containing a saved subscription.
    }
    throw new PushTransportError('INVALID_TARGET');
}

/**
 * Keep native web-push encryption/VAPID while owning bounded HTTPS delivery.
 * Only a shared-policy-admitted saved endpoint is accepted. The Agent's actual
 * lookup validates the entire one-shot OS answer set and returns those same
 * addresses to the socket; no preflight-then-default-DNS race or proxy exists.
 * TLS identity stays the original hostname. DNS has a five-second logical
 * deadline; the complete request/body has ten seconds, 16 KiB headers/body.
 * Native getaddrinfo itself cannot be canceled; late callbacks are ignored.
 * Dependencies are internal test seams, never supplied by an RPC request.
 */
export async function sendNativePush(
    subscription: webPush.PushSubscription,
    payload: string,
    options: PushOptions,
    admitted: AdmittedPushEndpoint,
    dependencies: PushTransportDependencies = {}
): Promise<webPush.SendResult> {
    const deadline = performance.now() + PUSH_TOTAL_TIMEOUT_MS;
    const target = checkedTarget(subscription.endpoint, admitted);
    const details = webPush.generateRequestDetails(subscription, payload, {
        TTL: options.TTL,
        urgency: options.urgency,
        vapidDetails: options.vapidDetails,
    });
    if (
        details.endpoint !== target.endpoint ||
        details.method !== 'POST' ||
        (details.body !== null &&
            (!Buffer.isBuffer(details.body) ||
                details.body.length > MAX_PUSH_RESPONSE_BYTES))
    )
        throw new PushTransportError('INVALID_REQUEST');
    const dns = pinnedLookup(
        target.hostname,
        deadline,
        dependencies.lookupAll ?? systemLookup
    );
    const agent = new Agent({
        keepAlive: false,
        maxSockets: 1,
        maxTotalSockets: 1,
        maxCachedSessions: 0,
        proxyEnv: {},
        lookup: dns.lookup,
        servername: target.hostname,
        rejectUnauthorized: true,
    });
    let outgoing: PushHttpRequest | undefined;
    let incoming: PushHttpResponse | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await new Promise<webPush.SendResult>((resolve, reject) => {
            let settled = false;
            const fail = (error: PushTransportError | webPush.WebPushError) => {
                if (settled) return;
                settled = true;
                reject(error);
                incoming?.destroy();
                outgoing?.destroy();
            };
            const withinDeadline = () => {
                if (performance.now() < deadline) return true;
                fail(new PushTransportError('TOTAL_TIMEOUT'));
                return false;
            };
            timer = setTimeout(
                () => fail(new PushTransportError('TOTAL_TIMEOUT')),
                Math.max(1, deadline - performance.now())
            );
            if (!withinDeadline()) return;
            try {
                outgoing = (dependencies.request ?? request)(
                    {
                        hostname: target.hostname,
                        port: 443,
                        path: target.requestPath,
                        method: 'POST',
                        headers: details.headers,
                        agent,
                        servername: target.hostname,
                        rejectUnauthorized: true,
                        maxHeaderSize: MAX_PUSH_HEADER_BYTES,
                    },
                    (response) => {
                        incoming = response;
                        response.once('error', () =>
                            fail(new PushTransportError('NETWORK'))
                        );
                        response.once('aborted', () =>
                            fail(new PushTransportError('NETWORK'))
                        );
                        if (settled || !withinDeadline()) {
                            response.destroy();
                            return;
                        }
                        let headers: webPush.Headers;
                        try {
                            headers = responseHeaders(response.headers);
                        } catch {
                            fail(new PushTransportError('RESPONSE_LIMIT'));
                            return;
                        }
                        const statusCode = response.statusCode;
                        if (
                            !statusCode ||
                            statusCode < 100 ||
                            statusCode > 599
                        ) {
                            fail(new PushTransportError('INVALID_RESPONSE'));
                            return;
                        }
                        let bytes = 0;
                        const chunks: Buffer[] = [];
                        response.on('data', (chunk) => {
                            if (settled || !withinDeadline()) return;
                            if (!Buffer.isBuffer(chunk)) {
                                fail(
                                    new PushTransportError('INVALID_RESPONSE')
                                );
                                return;
                            }
                            bytes += chunk.length;
                            if (bytes > MAX_PUSH_RESPONSE_BYTES) {
                                fail(new PushTransportError('RESPONSE_LIMIT'));
                                return;
                            }
                            chunks.push(chunk);
                        });
                        response.once('end', () => {
                            if (settled || !withinDeadline()) return;
                            settled = true;
                            const body = Buffer.concat(chunks).toString('utf8');
                            if (statusCode >= 200 && statusCode < 300)
                                resolve({ statusCode, body, headers });
                            else
                                reject(
                                    new webPush.WebPushError(
                                        'Received unexpected response code',
                                        statusCode,
                                        headers,
                                        body,
                                        target.endpoint
                                    )
                                );
                        });
                    }
                );
                outgoing.once('error', (error) =>
                    fail(
                        error instanceof PushTransportError
                            ? error
                            : new PushTransportError('NETWORK')
                    )
                );
                if (settled || !withinDeadline()) {
                    outgoing.destroy();
                    return;
                }
                outgoing.end(details.body ?? undefined);
            } catch {
                fail(new PushTransportError('NETWORK'));
            }
        });
    } finally {
        if (timer) clearTimeout(timer);
        dns.close();
        incoming?.destroy();
        outgoing?.destroy();
        agent.destroy();
    }
}
