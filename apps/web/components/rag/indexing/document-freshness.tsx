'use client';
import { useFormatter, useTranslations } from 'next-intl';
import type { IndexDocument } from './types';

/** Dates belong to the serving/initial generation, never to an unrelated library/task update. */
export function DocumentFreshness({
    document,
}: Readonly<{ document: IndexDocument }>) {
    const tr = useTranslations('rag.indexing.freshness');
    const format = useFormatter();
    if (!document.freshness) return null;
    const date = (value: Date) =>
        format.dateTime(value, { dateStyle: 'medium', timeStyle: 'short' });
    return (
        <div className='space-y-1'>
            <p>{tr(`states.${document.freshness}`)}</p>
            {document.desiredVersion !== null &&
                document.desiredVersion !== undefined && (
                    <p>
                        {tr('desiredVersion', {
                            version: document.desiredVersion,
                        })}
                    </p>
                )}
            {document.indexedAt && (
                <p>{tr('publishedAt', { date: date(document.indexedAt) })}</p>
            )}
            {document.pendingSince && (
                <p>
                    {tr('pendingSince', { date: date(document.pendingSince) })}
                </p>
            )}
        </div>
    );
}
