import './startup-config';
import { serve } from '@hono/node-server';
import { app } from './app';
import { prisma } from '@repo/db';
import { initializeVectorixPermissions } from '@repo/auth/permissions/rollout';
import { registerSignInNotifications } from './sign-in-notifications';
import { closeQueues } from '@repo/queues';
import { closeRateLimitStore } from '@repo/queues/rate-limit';
import { closeVectorAdapters } from '@routers/rag/indexing-runtime';
import { startRagTelemetry } from '@routers/rag/telemetry';
await initializeVectorixPermissions();
registerSignInNotifications();
const telemetry = startRagTelemetry(prisma);
const server = serve(
    { fetch: app.fetch, port: Number(process.env.PORT ?? 3001) },
    ({ port }) => console.log(`API listening on http://localhost:${port}`)
);
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
        server.close(async () => {
            await closeVectorAdapters();
            await closeQueues();
            await closeRateLimitStore();
            await telemetry.shutdown();
            await prisma.$disconnect();
            process.exit(0);
        });
    });
