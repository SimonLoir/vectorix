'use client';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogQueryState } from './catalog-controls';

export function QuotaOverview() {
    const { orpc } = useORPC();
    const query = useQuery(orpc.admin.rag.quota.queryOptions({ input: {} }));
    if (query.isPending || query.isError)
        return <CatalogQueryState query={query} />;
    const { limits, usage } = query.data;
    const bytes = (value: number) =>
        `${new Intl.NumberFormat('fr', { maximumFractionDigits: 2 }).format(value / 1024 ** 2)} Mio`;
    return (
        <div className='space-y-6'>
            <div className='grid gap-4 md:grid-cols-3'>
                {[
                    {
                        title: 'Collections',
                        value: `${usage.collections} / ${limits.collections}`,
                        note: 'Limite appliquée lors de la création',
                    },
                    {
                        title: 'Documents enregistrés',
                        value: `${usage.documents} / ${limits.documents}`,
                        note: 'Upload disponible dans une prochaine étape',
                    },
                    {
                        title: 'Stockage enregistré',
                        value: `${bytes(usage.storageBytes)} / ${bytes(limits.storageBytes)}`,
                        note: 'Originaux et extractions conservés',
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
            <section className='rounded-xl border p-6 space-y-4'>
                <h2 className='font-semibold'>Politiques enregistrées</h2>
                <dl className='grid gap-4 sm:grid-cols-2'>
                    <div>
                        <dt className='text-sm text-muted-foreground'>
                            Taille maximale d’un fichier
                        </dt>
                        <dd>{bytes(limits.originalBytes)}</dd>
                    </div>
                    <div>
                        <dt className='text-sm text-muted-foreground'>
                            Passages par collection
                        </dt>
                        <dd>
                            {limits.chunksPerCollection.toLocaleString('fr')}
                        </dd>
                    </div>
                </dl>
                <p className='text-sm text-muted-foreground'>
                    Les réservations de stockage et les limites de passages
                    seront appliquées avec l’ingestion. Ces valeurs ne
                    signifient pas qu’un upload ou un index existe déjà. Seul un
                    administrateur de plateforme peut modifier les quotas.
                </p>
            </section>
        </div>
    );
}
