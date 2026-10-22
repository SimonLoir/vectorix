'use client';
import { useTranslations } from 'next-intl';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import {
    OrganizationFeatureCard,
    type OrganizationFeature,
} from './organization-feature-card';

type SelectionState = {
    features: OrganizationFeature[];
    legacyFeatureVersion?: string | null;
    providers: { legacy?: { active: boolean } };
};

function selectedFeatures(features: OrganizationFeature[]) {
    const now = Date.now();
    return new Set(
        features
            .filter(
                (feature) =>
                    feature.override?.enabled === true &&
                    (!feature.override.expiresAt ||
                        new Date(feature.override.expiresAt).getTime() > now)
            )
            .map((feature) => feature.id)
    );
}

/** Preserves checkbox drafts across background reads and writes only the displayed catalogue/grant snapshot. */
export function OrganizationLegacyFeatureEditor({
    organizationId,
    data,
    fetching,
    readFailed,
    onReload,
}: Readonly<{
    organizationId: string;
    data: SelectionState;
    fetching: boolean;
    readFailed: boolean;
    onReload: () => Promise<SelectionState | undefined>;
}>) {
    const tr = useTranslations('admin.core');
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const [features, setFeatures] = useState(data.features);
    const [version, setVersion] = useState(data.legacyFeatureVersion);
    const [selected, setSelected] = useState(() =>
        selectedFeatures(data.features)
    );
    const [requiresReload, setRequiresReload] = useState(false);
    const mutation = useMutation(
        orpc.superadmin.organizations.setLegacyFeatures.mutationOptions({
            retry: false,
            onError: () => setRequiresReload(true),
            onSuccess: async (result) => {
                setVersion(result.version);
                setSelected(new Set(result.enabledFeatureIds));
                setRequiresReload(false);
                toast.success(tr('legacyFeaturesSaved'));
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.organizations.features.key(),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.audit.key(),
                    }),
                ]);
            },
        })
    );
    const stale = data.legacyFeatureVersion !== version;
    const busy = fetching || mutation.isPending;
    const blocked = !version || busy || requiresReload || stale || readFailed;
    const selectableFeatures = features.filter(
        (feature) => feature.isActive && feature.key !== 'integrations'
    );
    const allSelectableSelected = selectableFeatures.every((feature) =>
        selected.has(feature.id)
    );

    async function reload() {
        const current = await onReload();
        if (!current || current.providers.legacy?.active !== true) return;
        setFeatures(current.features);
        setVersion(current.legacyFeatureVersion);
        setSelected(selectedFeatures(current.features));
        setRequiresReload(false);
        mutation.reset();
    }

    return (
        <div className='space-y-5 p-5'>
            <p className='text-sm text-slate-400'>{tr('selectFeaturesHint')}</p>
            {version ? null : (
                <p role='alert' className='text-sm text-amber-200'>
                    {tr('updateApiHint')}
                </p>
            )}
            {requiresReload || stale ? (
                <p role='alert' className='text-sm text-amber-200'>
                    {tr('reloadSelectionHint')}
                </p>
            ) : null}
            {mutation.isError ? (
                <p role='alert' className='text-sm text-destructive'>
                    {tr('saveFailed')}
                </p>
            ) : null}
            <div className='flex justify-end'>
                <Button
                    variant='outline'
                    disabled={blocked || allSelectableSelected}
                    onClick={() =>
                        setSelected(
                            (previous) =>
                                new Set([
                                    ...previous,
                                    ...selectableFeatures.map(
                                        (feature) => feature.id
                                    ),
                                ])
                        )
                    }
                >
                    {tr('selectAll')}
                </Button>
            </div>
            <div className='grid gap-3 lg:grid-cols-2'>
                {features.map((feature) => (
                    <OrganizationFeatureCard
                        key={feature.id}
                        feature={feature}
                        selected={selected.has(feature.id)}
                        disabled={
                            blocked ||
                            (!feature.isActive && !selected.has(feature.id))
                        }
                        onToggle={(checked) =>
                            setSelected((previous) => {
                                const next = new Set(previous);
                                if (checked) next.add(feature.id);
                                else next.delete(feature.id);
                                return next;
                            })
                        }
                    />
                ))}
            </div>
            <div className='flex flex-wrap items-center justify-between gap-4 border-t border-white/8 pt-5'>
                <span className='text-sm text-slate-400'>
                    {tr('selectedFeaturesCount', { count: selected.size })}
                </span>
                <div className='flex flex-wrap gap-2'>
                    <Button
                        variant='outline'
                        disabled={busy}
                        onClick={() => void reload()}
                    >
                        <RefreshCw
                            className={`h-4 w-4 ${fetching ? 'animate-spin' : ''}`}
                        />
                        {tr('reload')}
                    </Button>
                    <Button
                        disabled={blocked}
                        onClick={() => {
                            if (version)
                                mutation.mutate({
                                    organizationId,
                                    expectedVersion: version,
                                    enabledFeatureIds: [...selected],
                                });
                        }}
                    >
                        {mutation.isPending
                            ? tr('saving')
                            : tr('saveSelection')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
