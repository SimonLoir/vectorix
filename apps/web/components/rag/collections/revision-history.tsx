'use client';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import LocalizedDate from '@/components/localized-date';
import {
    CatalogPagination,
    CatalogQueryState,
    useCatalogPagination,
} from '../catalog-controls';
import { ProfileSummary } from './profile-summary';

export function RevisionHistory({ id }: Readonly<{ id: string }>) {
    const tr = useTranslations('rag');
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const query = useQuery(
        orpc.admin.rag.collections.revisions.queryOptions({
            input: { id, offset: page.offset, limit: page.limit, query: '' },
        })
    );
    return (
        <section className='rounded-xl border p-5 space-y-4'>
            <h2 className='text-lg font-semibold'>{tr('history.title')}</h2>
            <p className='text-sm text-muted-foreground'>
                {tr('history.description')}
            </p>
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    {query.data.items.map((item) => (
                        <details
                            className='rounded-lg border p-4'
                            key={item.revision}
                        >
                            <summary className='cursor-pointer font-medium'>
                                {tr('history.revision', {
                                    revision: item.revision,
                                    model: item.configuration.model,
                                })}{' '}
                                ·{' '}
                                <LocalizedDate
                                    value={item.createdAt}
                                    timeStyle='short'
                                />
                            </summary>
                            <div className='mt-4'>
                                <ProfileSummary
                                    configuration={item.configuration}
                                />
                            </div>
                        </details>
                    ))}
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
        </section>
    );
}
