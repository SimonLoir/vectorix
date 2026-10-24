import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth } from '@repo/auth';
import { prisma } from '@repo/db';
import { getQueues } from '@repo/queues';
import { logger } from './lib/logger';
import {
    API_VERSION_RESPONSE_HEADERS,
    withApiVersionHeaders,
} from './api-versioning/headers';
import { generateOpenApiSpec } from './api-versioning/openapi';
import {
    API_VERSION_REGISTRY,
    CURRENT_API_VERSION,
    getPublicApiVersions,
} from './api-versioning/registry';
import { API_VERSION_RUNTIMES } from './api-versioning/runtime';
import { createScalarPageHandler } from './api-versioning/scalar-page';
import { createScalarAssetHandler } from './api-versioning/scalar-asset';
import {
    scalarIconHandler,
    SCALAR_ICON_PATH,
} from './api-versioning/scalar-icon';
import { requestBodyLimit } from './http/request-body-limit';
import { cookieCsrfProtection } from './http/cookie-csrf';
import { resolveTrustedOrigins } from './http/trusted-origins';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
    parseTrustedProxies,
    resolveClientIp,
    withClientIp,
} from './http/client-ip';
import { VECTORIX_CSRF_HEADER } from '@repo/api/transport-security';
export const app = new Hono();
const origins = resolveTrustedOrigins(process.env.TRUSTED_ORIGINS);
const trustedProxies = parseTrustedProxies(
    process.env.VECTORIX_TRUSTED_PROXIES
);
app.use(
    '*',
    cors({
        origin: origins,
        credentials: true,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: [
            'Content-Type',
            'Authorization',
            'x-api-key',
            'Vectorix-Expected-Organization-Id',
            VECTORIX_CSRF_HEADER,
        ],
        exposeHeaders: [
            ...API_VERSION_RESPONSE_HEADERS,
            'Content-Disposition',
            'Standard-Server',
        ],
    })
);
app.use('*', cookieCsrfProtection(API_VERSION_REGISTRY, origins));
app.use('*', requestBodyLimit(API_VERSION_REGISTRY));
app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    let peer: string | undefined;
    try {
        peer = getConnInfo(c).remote.address;
    } catch {
        // In-process requests (tests) have no socket peer.
    }
    const clientIp = resolveClientIp(
        peer,
        c.req.raw.headers.get('x-forwarded-for'),
        trustedProxies
    );
    return auth.handler(withClientIp(c.req.raw, clientIp));
});
app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/ready', async (c) => {
    await prisma.organization.count();
    await getQueues().notifications.getJobCounts();
    return c.json({ status: 'ok' });
});
for (const runtime of API_VERSION_RUNTIMES) {
    const { version, rpcHandler, openApiHandler } = runtime;
    for (const [prefix, handler] of [
        [version.rpcPath, rpcHandler],
        [version.restPath, openApiHandler],
    ] as const) {
        app.all(`${prefix}/*`, async (c) => {
            const { matched, response } = await handler.handle(c.req.raw, {
                prefix,
                context: { headers: c.req.raw.headers, db: prisma, logger },
            });
            return withApiVersionHeaders(
                matched ? response : await c.notFound(),
                version
            );
        });
    }
    app.get(version.specPath, async (c) =>
        withApiVersionHeaders(
            c.json(await generateOpenApiSpec(version)),
            version
        )
    );
}
app.get('/spec.json', async (c) =>
    c.json(await generateOpenApiSpec(CURRENT_API_VERSION))
);
app.get('/api-versions.json', (c) =>
    c.json({
        currentMajor: CURRENT_API_VERSION.major,
        versions: getPublicApiVersions(),
    })
);
app.get(SCALAR_ICON_PATH, scalarIconHandler);
app.get('/_playground/scalar/:file', createScalarAssetHandler());
app.get('/', createScalarPageHandler(getPublicApiVersions()));
