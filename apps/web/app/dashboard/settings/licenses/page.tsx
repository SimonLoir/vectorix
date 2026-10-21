'use client';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import DashboardPage from '@/components/dashboard-page';
export default function LicensesPage() {
    const { orpc } = useORPC();
    const query = useQuery(orpc.admin.organization.features.queryOptions({}));
    return (
        <DashboardPage>
            <h1 className='text-2xl font-semibold'>
                Licences et fonctionnalités
            </h1>
            {query.isPending ? (
                <p className='mt-6'>Chargement…</p>
            ) : query.isError ? (
                <p role='alert'>{query.error.message}</p>
            ) : (
                <div className='mt-6 space-y-4'>
                    {query.data.providers.external.error && (
                        <p role='alert'>
                            {query.data.providers.external.error}
                        </p>
                    )}
                    {query.data.features.length === 0 ? (
                        <p className='text-muted-foreground'>
                            Aucune fonctionnalité sous licence n’est configurée.
                        </p>
                    ) : (
                        query.data.features.map((feature) => (
                            <div
                                className='flex items-center justify-between rounded-lg border p-4'
                                key={feature.id}
                            >
                                <div>
                                    <h2 className='font-medium'>
                                        {feature.name}
                                    </h2>
                                    <p className='text-sm text-muted-foreground'>
                                        {feature.description}
                                    </p>
                                </div>
                                <span>
                                    {feature.enabled ? 'Activée' : 'Désactivée'}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            )}
        </DashboardPage>
    );
}
