import type { Context, MiddlewareHandler } from 'hono';
import {
    VECTORIX_CSRF_HEADER,
    VECTORIX_CSRF_VALUE,
} from '@repo/api/transport-security';
import type { ApiVersionDefinition } from '../api-versioning/registry';
import { withApiVersionHeaders } from '../api-versioning/headers';
import { httpRefererOrigin, serializedHttpOrigin } from './trusted-origins';

type CsrfVersion = Pick<
    ApiVersionDefinition,
    'major' | 'revision' | 'status' | 'rpcPath' | 'restPath'
>;
type RequestHeaders = Pick<Headers, 'get'>;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every cookie-bearing unsafe request is checked, including a cookie combined
 * with an API key or bearer. Explicit Origin/Referer always takes precedence;
 * the public non-secret marker only admits originless server/CLI requests.
 * Fetch Metadata and request Host never establish a trusted origin.
 */
export function cookieCsrfDecision(
    method: string,
    headers: RequestHeaders,
    trustedOrigins: readonly string[]
): boolean {
    if (SAFE_METHODS.has(method) || headers.get('cookie') === null) return true;
    const origin = headers.get('origin');
    if (origin !== null) {
        const parsed = serializedHttpOrigin(origin);
        return parsed !== null && trustedOrigins.includes(parsed);
    }
    const referer = headers.get('referer');
    if (referer !== null) {
        const parsed = httpRefererOrigin(referer);
        return parsed !== null && trustedOrigins.includes(parsed);
    }
    return headers.get(VECTORIX_CSRF_HEADER) === VECTORIX_CSRF_VALUE;
}

function hasPrefix(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function transport(pathname: string, versions: readonly CsrfVersion[]) {
    for (const version of versions) {
        if (hasPrefix(pathname, version.rpcPath)) return { version, rpc: true };
        if (hasPrefix(pathname, version.restPath))
            return { version, rpc: false };
    }
    return null;
}

function forbidden(context: Context, version: CsrfVersion, rpc: boolean) {
    const error = {
        defined: false,
        code: 'FORBIDDEN',
        status: 403,
        message: 'Request origin is not allowed.',
    };
    return withApiVersionHeaders(
        context.json(rpc ? { json: error } : error, 403),
        version
    );
}

/**
 * Run after CORS/preflight and before body limits, authentication and oRPC.
 * Guard every supported major's exact transport prefix. Refusals never parse
 * the body or log headers. Do not access/cancel a rejected body: cancelling an
 * unstarted Undici FormData producer can reject a detached encoder task. The
 * Node HTTP adapter owns bounded unread-input cleanup after sending the 403.
 * Accepted requests retain the original body, headers, URL and abort signal.
 */
export function cookieCsrfProtection(
    versions: readonly CsrfVersion[],
    trustedOrigins: readonly string[]
): MiddlewareHandler {
    return async (context, next) => {
        const request = context.req.raw;
        const match = transport(new URL(request.url).pathname, versions);
        if (
            match &&
            !cookieCsrfDecision(request.method, request.headers, trustedOrigins)
        ) {
            return forbidden(context, match.version, match.rpc);
        }
        await next();
    };
}
