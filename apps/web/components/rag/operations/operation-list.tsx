'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { OperationFailure } from './operation-failure';
import { OperationRecovery } from './operation-recovery';
import type { Operations } from './types';

export function OperationList({
    items,
    observedAt,
    onInspectCleanup,
}: Readonly<{
    items: Operations['items'];
    observedAt: Date;
    onInspectCleanup: (collection: { id: string; name: string }) => void;
}>) {
    const tr = useTranslations('rag.operations');
    const format = useFormatter();
    const date = (value: Date) =>
        format.dateTime(value, { dateStyle: 'medium', timeStyle: 'short' });
    return (
        <ul className='space-y-3'>
            {items.map((item) => {
                const minutes = Math.max(
                    0,
                    Math.floor(
                        (observedAt.getTime() - item.createdAt.getTime()) /
                            60_000
                    )
                );
                return (
                    <li
                        key={`${item.category}:${item.id}`}
                        className='space-y-2 rounded-lg border p-4 text-sm'
                    >
                        <h3 className='break-words font-medium'>{item.name}</h3>
                        <p>
                            {tr(`kinds.${item.kind}`)} ·{' '}
                            {tr(`states.${item.state}`)}
                        </p>
                        {item.version !== null && (
                            <p>{tr('version', { version: item.version })}</p>
                        )}
                        {item.target.deleted && <p>{tr('deletedTarget')}</p>}
                        <p>{tr('accepted', { date: date(item.createdAt) })}</p>
                        <p>{tr('age', { minutes })}</p>
                        <p>{tr('attempts', { count: item.attempts })}</p>
                        {item.state === 'SCHEDULED' && (
                            <p>
                                {tr('available', {
                                    date: date(item.availableAt),
                                })}
                            </p>
                        )}
                        {item.leasedUntil &&
                            ['LEASED', 'EXPIRED'].includes(item.state) && (
                                <p>
                                    {tr('leaseDeadline', {
                                        date: date(item.leasedUntil),
                                    })}
                                </p>
                            )}
                        <OperationFailure item={item} />
                        <OperationRecovery
                            item={item}
                            onInspectCleanup={onInspectCleanup}
                        />
                    </li>
                );
            })}
        </ul>
    );
}
