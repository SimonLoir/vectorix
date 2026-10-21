import { Queue } from 'bullmq';
export const QueueName = { NOTIFICATIONS: 'notifications' } as const;
const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
export const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || (process.env.REDIS_PASSWORD ?? undefined),
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
};
let queues: { notifications: Queue } | undefined;
/** Lazily create Redis connections so importing contracts never connects to infrastructure. */
export function getQueues() {
    return (queues ??= {
        notifications: new Queue(QueueName.NOTIFICATIONS, { connection }),
    });
}
export type Queues = ReturnType<typeof getQueues>;
export async function closeQueues() {
    if (queues) {
        await queues.notifications.close();
        queues = undefined;
    }
}
