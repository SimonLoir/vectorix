import { Worker } from 'bullmq';
import { connection, getQueues, QueueName, closeQueues } from '@repo/queues';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import {
    processCollectionIndexing,
    closeVectorAdapters,
} from '@routers/rag/indexing';
import { parseRichDocument } from './extraction/main';
import { processNotifications } from './notifications/process';
import { startWorkerObservations } from './observations';
const observations = startWorkerObservations(prisma);
const worker = new Worker(
    QueueName.NOTIFICATIONS,
    () =>
        observations.scan('NOTIFICATIONS', () => processNotifications(prisma)),
    { connection, concurrency: 1 }
);
worker.on('error', (error) =>
    console.error('Notification worker error:', error.message)
);
worker.on('failed', (_job, error) =>
    console.error('Notification scan failed:', error.message)
);
await worker.waitUntilReady();
observations.ready('NOTIFICATIONS');
await getQueues().notifications.upsertJobScheduler(
    'notification-deliveries',
    { every: 10_000 },
    { name: 'scan', data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } }
);
const documentWorker = new Worker(
    QueueName.DOCUMENTS,
    () =>
        observations.scan('DOCUMENTS', async () => {
            await processDocumentIngestions(prisma, parseRichDocument);
            await processDocumentCleanups(prisma);
        }),
    { connection, concurrency: 1 }
);
documentWorker.on('error', () =>
    console.error('Document worker connection failed')
);
documentWorker.on('failed', () =>
    console.error('Document scan failed; durable tasks will be retried')
);
await documentWorker.waitUntilReady();
observations.ready('DOCUMENTS');
await getQueues().documents.upsertJobScheduler(
    'document-ingestion',
    { every: 5000 },
    { name: 'scan', data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } }
);
const indexingWorker = new Worker(
    QueueName.INDEXING,
    () =>
        observations.scan('INDEXING', () => processCollectionIndexing(prisma)),
    { connection, concurrency: 1 }
);
indexingWorker.on('error', () =>
    console.error('Indexing worker connection failed')
);
indexingWorker.on('failed', () =>
    console.error('Indexing scan failed; durable tasks will be retried')
);
await indexingWorker.waitUntilReady();
observations.ready('INDEXING');
await getQueues().indexing.upsertJobScheduler(
    'collection-indexing',
    { every: 5000 },
    { name: 'scan', data: {}, opts: { removeOnComplete: 20, removeOnFail: 20 } }
);
console.log('Notification, document and indexing workers ready');
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
        await Promise.all([
            worker.close(),
            documentWorker.close(),
            indexingWorker.close(),
        ]);
        await closeVectorAdapters();
        await closeQueues();
        await observations.shutdown();
        await prisma.$disconnect();
        process.exit(0);
    });
