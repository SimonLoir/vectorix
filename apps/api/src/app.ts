import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
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
    CURRENT_API_VERSION,
    getPublicApiVersions,
} from './api-versioning/registry';
import { API_VERSION_RUNTIMES } from './api-versioning/runtime';
import { renderScalarHtml } from './api-versioning/scalar';
export const app = new Hono();
const origins = (
    process.env.TRUSTED_ORIGINS ?? 'http://localhost:3000,http://localhost:3006'
)
    .split(',')
    .map((value) => value.trim());
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
        ],
        exposeHeaders: [
            ...API_VERSION_RESPONSE_HEADERS,
            'Content-Disposition',
            'Standard-Server',
        ],
    })
);
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/ready', async (c) => {
    await prisma.organization.count();
    await getQueues().notifications.getJobCounts();
    return c.json({ status: 'ok' });
});
for (const runtime of API_VERSION_RUNTIMES) {
    for (const uploadPath of [
        `${runtime.version.rpcPath}/admin/rag/documents/upload`,
        `${runtime.version.restPath}/admin/rag/documents/uploads`,
        `${runtime.version.rpcPath}/admin/rag/documents/replace`,
        `${runtime.version.restPath}/admin/rag/documents/:id/replacements`,
    ])
        app.use(uploadPath, bodyLimit({ maxSize: 26 * 1024 * 1024 }));
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
app.get('/', (c) => c.html(renderScalarHtml(getPublicApiVersions())));
