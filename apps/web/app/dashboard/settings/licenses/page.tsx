'use client';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useORPC } from '@/hooks/use-orpc';
import DashboardPage from '@/components/dashboard-page';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';
import { RequestErrorState } from '@/components/request-error-state';
export default function LicensesPage() {
    const { orpc } = useORPC();
    const t = useTranslations('licenses');
    const query = useQuery(orpc.admin.organization.features.queryOptions({}));
    return (
        <DashboardPage>
            <h1 className='text-2xl font-semibold'>{t('title')}</h1>
            <p role='note' className='mt-2 text-sm text-muted-foreground'>
                {t('informational')}
            </p>
            {query.isPending ? (
                <p className='mt-6'>{t('loading')}</p>
            ) : query.isError ? (
                <RequestErrorState
                    errorKey={requestErrorKey(query.error)}
                    onRetry={query.refetch}
                />
            ) : (
                <div className='mt-6 space-y-4'>
                    {query.data.providers.external.error && (
                        <p role='alert'>
                            {query.data.providers.external.error}
                        </p>
                    )}
                    {query.data.features.length === 0 ? (
                        <p className='text-muted-foreground'>{t('empty')}</p>
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
                                    {feature.enabled
                                        ? t('enabled')
                                        : t('disabled')}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            )}
        </DashboardPage>
    );
}
