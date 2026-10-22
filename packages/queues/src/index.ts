import { Queue } from 'bullmq';
import { buildRedisConnection } from './redis-connection';
export const QueueName = {
    NOTIFICATIONS: 'notifications',
    DOCUMENTS: 'documents',
    INDEXING: 'indexing',
} as const;
export const connection = buildRedisConnection({
    REDIS_URL: process.env.REDIS_URL,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
});
let queues:
    { notifications: Queue; documents: Queue; indexing: Queue } | undefined;
/** Lazily create Redis connections so importing contracts never connects to infrastructure. */
export function getQueues() {
    return (queues ??= {
        notifications: new Queue(QueueName.NOTIFICATIONS, { connection }),
        documents: new Queue(QueueName.DOCUMENTS, { connection }),
        indexing: new Queue(QueueName.INDEXING, { connection }),
    });
}
export type Queues = ReturnType<typeof getQueues>;
export async function closeQueues() {
    if (queues) {
        await Promise.all([
            queues.notifications.close(),
            queues.documents.close(),
            queues.indexing.close(),
        ]);
        queues = undefined;
    }
}
