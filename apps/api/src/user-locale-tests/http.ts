import assert from 'node:assert/strict';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { z } from 'zod';
import { app } from '../app';

const origin = 'http://localhost:3000';

/** Read native JSON without including response bodies in assertion or parser failures. */
async function payload(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === '') return null;
    try {
        const value: unknown = JSON.parse(text);
        return value;
    } catch {
        throw new Error('The locale HTTP fixture received malformed JSON.');
    }
}

/** A real cookie jar with separate, explicit header-only requests for negative controls. */
export function localeBrowser() {
    const cookies = new Map<string, string>();
    const headers = () => ({
        origin,
        cookie: [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join('; '),
    });
    async function request(path: string, body?: unknown) {
        const result = await localeRequest(path, body, headers());
        for (const header of result.response.headers.getSetCookie()) {
            const pair = header.split(';')[0]!;
            const separator = pair.indexOf('=');
            const name = pair.slice(0, separator);
            const value = pair.slice(separator + 1);
            if (!value || /max-age=0(?:;|$)/i.test(header))
                cookies.delete(name);
            else cookies.set(name, value);
        }
        return result;
    }
    function client(): VectorixApiV1Client {
        return createORPCClient(
            new RPCLink({
                url: 'http://localhost:3001/rpc/v1',
                headers,
                fetch: (request) => Promise.resolve(app.request(request)),
            })
        );
    }
    return { request, client };
}

/** Native HTTP transport with no ambient cookie when the caller supplies none. */
export async function localeRequest(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
) {
    const response = await app.request(
        `http://localhost:3001/api/auth/${path}`,
        {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                origin,
                ...headers,
                ...(body === undefined
                    ? {}
                    : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
    );
    return { response, body: await payload(response) };
}

type NativeResult = Awaited<ReturnType<typeof localeRequest>>;

/** Avoid asserting entire native user/session objects, which can contain session tokens. */
export function object(value: unknown): Record<string, unknown> {
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    assert.ok(parsed.success, 'The native response must contain an object.');
    return parsed.data;
}

export function success(result: NativeResult) {
    assert.equal(result.response.status, 200);
    return object(result.body);
}

export function denied(result: NativeResult, status: number, code: string) {
    assert.equal(result.response.status, status);
    assert.equal(object(result.body).code, code);
}

export function stringField(value: unknown): string {
    assert.ok(
        typeof value === 'string',
        'The native response must contain a string field.'
    );
    return value;
}
