'use client';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import LocalizedDate from '@/components/localized-date';
import {
    CatalogPagination,
    CatalogQueryState,
    CatalogSearch,
    useCatalogPagination,
} from './catalog-controls';

const actionKeys: Readonly<Record<string, string>> = {
    'collection.index.synchronization.adopted': 'synchronizationAdopted',
    'collection.reranking.configure': 'rerankingConfigured',
    'reranking.endpoint.create': 'rerankingEndpointCreated',
    'reranking.endpoint.update': 'rerankingEndpointUpdated',
    'reranking.endpoint.activate': 'rerankingEndpointActivated',
    'reranking.endpoint.delete': 'rerankingEndpointDeleted',
};

export function RagAuditList() {
    const tr = useTranslations('rag');
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const query = useQuery(
        orpc.admin.rag.audit.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        })
    );
    return (
        <div className='space-y-4'>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('audit.search')}
            />
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <ol className='rounded-xl border divide-y'>
                        {query.data.items.map((item) => (
                            <li className='space-y-2 p-5' key={item.id}>
                                <div className='flex flex-wrap justify-between gap-2'>
                                    <h2 className='font-medium'>
                                        {actionKeys[item.action]
                                            ? tr(
                                                  `audit.${actionKeys[item.action]}`
                                              )
                                            : item.action}
                                    </h2>
                                    <span className='text-sm text-muted-foreground'>
                                        <LocalizedDate
                                            value={item.createdAt}
                                            timeStyle='short'
                                        />
                                    </span>
                                </div>
                                <p className='text-sm break-all'>
                                    {tr('audit.actor', {
                                        type: item.actorType,
                                        id: item.actorId,
                                    })}
                                </p>
                                {item.targetId && (
                                    <p className='text-sm text-muted-foreground break-all'>
                                        {tr('audit.target', {
                                            id: item.targetId,
                                        })}
                                    </p>
                                )}
                                {item.details && (
                                    <dl className='grid gap-2 sm:grid-cols-2'>
                                        {Object.entries(item.details).map(
                                            ([label, value]) => (
                                                <div
                                                    className='text-sm break-all'
                                                    key={label}
                                                >
                                                    <dt className='text-muted-foreground'>
                                                        {label}
                                                    </dt>
                                                    <dd>{String(value)}</dd>
                                                </div>
                                            )
                                        )}
                                    </dl>
                                )}
                            </li>
                        ))}
                        {query.data.total === 0 && (
                            <li className='p-8 text-center text-muted-foreground'>
                                {tr('audit.empty')}
                            </li>
                        )}
                    </ol>
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
        </div>
    );
}
