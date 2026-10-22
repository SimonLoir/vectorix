import { Worker } from 'bullmq';
import { connection, getQueues, QueueName, closeQueues } from '@repo/queues';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { processNotifications } from './notifications/process';
const worker = new Worker(
    QueueName.NOTIFICATIONS,
    () => processNotifications(prisma),
    { connection, concurrency: 1 }
);
worker.on('error', (error) =>
    console.error('Notification worker error:', error.message)
);
worker.on('failed', (_job, error) =>
    console.error('Notification scan failed:', error.message)
);
await worker.waitUntilReady();
await getQueues().notifications.upsertJobScheduler(
    'notification-deliveries',
    { every: 10_000 },
    { name: 'scan', data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } }
);
const documentWorker = new Worker(
    QueueName.DOCUMENTS,
    async () => {
        await processDocumentIngestions(prisma);
        await processDocumentCleanups(prisma);
    },
    { connection, concurrency: 1 }
);
documentWorker.on('error', () =>
    console.error('Document worker connection failed')
);
documentWorker.on('failed', () =>
    console.error('Document scan failed; durable tasks will be retried')
);
await documentWorker.waitUntilReady();
await getQueues().documents.upsertJobScheduler(
    'document-ingestion',
    { every: 5000 },
    { name: 'scan', data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } }
);
console.log('Notification and document workers ready');
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
        await Promise.all([worker.close(), documentWorker.close()]);
        await closeQueues();
        await prisma.$disconnect();
        process.exit(0);
    });
