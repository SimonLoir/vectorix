'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { SemanticQuotaOverview } from './semantic-quota-overview';
import { CatalogQueryState } from './catalog-controls';

export function QuotaOverview() {
    const tr = useTranslations('rag');
    const format = useFormatter();
    const { orpc } = useORPC();
    const query = useQuery({
        ...orpc.admin.rag.quota.queryOptions({ input: {} }),
        retry: false,
        refetchInterval: 15_000,
    });
    if (query.isPending || query.isError)
        return <CatalogQueryState query={query} />;
    const { limits, usage } = query.data;
    const bytes = (value: number) =>
        tr('common.mebibytes', { value: value / 1024 ** 2 });
    return (
        <div className='space-y-6'>
            <div className='grid gap-4 md:grid-cols-3'>
                {[
                    {
                        title: tr('collections.title'),
                        value: `${format.number(usage.collections)} / ${format.number(limits.collections)}`,
                        note: tr('usage.collectionsHint'),
                    },
                    {
                        title: tr('usage.documents'),
                        value: `${format.number(usage.documents)} / ${format.number(limits.documents)}`,
                        note: tr('usage.documentsHint'),
                    },
                    {
                        title: tr('usage.storage'),
                        value: `${bytes(usage.storageBytes)} / ${bytes(limits.storageBytes)}`,
                        note: tr('usage.storageHint'),
                    },
                ].map((item) => (
                    <article
                        className='rounded-xl border bg-card p-6'
                        key={item.title}
                    >
                        <h2 className='text-sm text-muted-foreground'>
                            {item.title}
                        </h2>
                        <p className='mt-3 text-2xl font-semibold'>
                            {item.value}
                        </p>
                        <p className='mt-3 text-xs text-muted-foreground'>
                            {item.note}
                        </p>
                    </article>
                ))}
            </div>
            {query.data.semantic && (
                <SemanticQuotaOverview semantic={query.data.semantic} />
            )}
            <section className='rounded-xl border p-6 space-y-4'>
                <h2 className='font-semibold'>{tr('usage.policies')}</h2>
                <dl className='grid gap-4 sm:grid-cols-2'>
                    <div>
                        <dt className='text-sm text-muted-foreground'>
                            {tr('usage.fileMaximum')}
                        </dt>
                        <dd>{bytes(limits.originalBytes)}</dd>
                    </div>
                    <div>
                        <dt className='text-sm text-muted-foreground'>
                            {tr('usage.temporaryChunks')}
                        </dt>
                        <dd>
                            {format.number(limits.temporaryChunksPerCollection)}
                        </dd>
                    </div>
                    <div>
                        <dt className='text-sm text-muted-foreground'>
                            {tr('usage.chunks')}
                        </dt>
                        <dd>{format.number(limits.chunksPerCollection)}</dd>
                    </div>
                </dl>
                <p className='text-sm text-muted-foreground'>
                    {tr('usage.policyHint')}
                </p>
            </section>
        </div>
    );
}
