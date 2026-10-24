'use client';
import { useTranslations } from 'next-intl';

import { useQuery } from '@tanstack/react-query';
import { Layers3 } from 'lucide-react';
import { Badge } from '@repo/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';
import { OrganizationLegacyFeatureEditor } from './organization-legacy-feature-editor';
import { OrganizationFeatureCard } from './organization-feature-card';
import { EntitlementsNotice } from './entitlements-notice';

/** Displays provider rights and lets superadmins explicitly select the legacy organization's grants. */
export function OrganizationFeatures({
    organizationId,
}: {
    readonly organizationId: string;
}) {
    const tr = useTranslations('admin.core');
    const { orpc } = useORPC();
    const query = useQuery(
        orpc.superadmin.organizations.features.queryOptions({
            input: { organizationId },
        })
    );
    if (query.isPending) return <LoadingState label={tr('featuresLoading')} />;
    if (!query.data)
        return (
            <p className='text-sm text-destructive'>
                {tr('featuresUnavailable')}
            </p>
        );

    const legacy = query.data.providers.legacy?.active === true;
    const external = query.data.providers.external;
    return (
        <Card className='admin-panel gap-0 overflow-hidden rounded-2xl py-0 shadow-none'>
            <CardHeader className='space-y-3 border-b border-white/8 py-5'>
                <CardTitle className='flex items-center gap-2 text-base'>
                    <Layers3 className='h-4 w-4 text-indigo-300' />
                    {tr('vectorixFeatures')}
                </CardTitle>
                <p className='text-sm text-slate-400'>
                    {legacy
                        ? tr('legacyFeaturesHint')
                        : tr('externalFeaturesHint')}
                </p>
                <EntitlementsNotice />
                {query.isError && (
                    <p role='alert' className='text-sm text-amber-200'>
                        {tr('refreshFailed')}
                    </p>
                )}
                <div>
                    <Badge
                        variant={
                            legacy || external.reachable
                                ? 'default'
                                : 'secondary'
                        }
                    >
                        {legacy
                            ? tr('legacyAccess')
                            : external.configured
                              ? external.reachable
                                  ? tr('externalReachable')
                                  : tr('externalUnavailable')
                              : tr('externalNotConfigured')}
                    </Badge>
                </div>
                {!legacy && external.error && (
                    <p className='text-xs text-amber-300'>
                        {tr('externalUnavailable')}
                    </p>
                )}
            </CardHeader>
            {legacy ? (
                <OrganizationLegacyFeatureEditor
                    key={organizationId}
                    organizationId={organizationId}
                    data={query.data}
                    fetching={query.isFetching}
                    readFailed={query.isError}
                    onReload={async () => {
                        const result = await query.refetch();
                        return result.isSuccess ? result.data : undefined;
                    }}
                />
            ) : (
                <CardContent className='grid gap-3 p-5 lg:grid-cols-2'>
                    {query.data.features.map((feature) => (
                        <OrganizationFeatureCard
                            key={feature.id}
                            feature={feature}
                        />
                    ))}
                </CardContent>
            )}
        </Card>
    );
}
