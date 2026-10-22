import { serve } from '@hono/node-server';
import { app } from './app';
import { prisma } from '@repo/db';
import { initializeVectorixPermissions } from '@repo/auth/permissions/rollout';
import { registerSignInNotifications } from './sign-in-notifications';
import { closeQueues } from '@repo/queues';
import { closeVectorAdapters } from '@routers/rag/indexing-runtime';
await initializeVectorixPermissions();
registerSignInNotifications();
const server = serve(
    { fetch: app.fetch, port: Number(process.env.PORT ?? 3001) },
    ({ port }) => console.log(`API listening on http://localhost:${port}`)
);
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
        server.close(async () => {
            await closeVectorAdapters();
            await closeQueues();
            await prisma.$disconnect();
            process.exit(0);
        });
    });
