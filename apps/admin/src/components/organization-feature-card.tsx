'use client';
import { useTranslations, useFormatter } from 'next-intl';
import type { VectorixApiV1Outputs } from '@repo/api';
import { Badge } from '@repo/ui/badge';
import { Checkbox } from '@repo/ui/checkbox';

export type OrganizationFeature =
    VectorixApiV1Outputs['superadmin']['organizations']['features']['features'][number];

/** Distinguishes a selected organization grant from the catalogue's global activation. */
export function OrganizationFeatureCard({
    feature,
    selected,
    onToggle,
    disabled,
}: Readonly<{
    feature: OrganizationFeature;
    selected?: boolean;
    onToggle?: (checked: boolean) => void;
    disabled?: boolean;
}>) {
    const tr = useTranslations('admin.core');
    const format = useFormatter();
    return (
        <div
            className={`rounded-2xl border p-4 ${(selected ?? feature.enabled) ? 'border-cyan-400/20 bg-cyan-400/[0.035]' : 'border-white/8 bg-white/[0.015]'}`}
        >
            <div className='flex items-start justify-between gap-4'>
                <div className='min-w-0'>
                    <label
                        htmlFor={
                            onToggle
                                ? `legacy-feature-${feature.id}`
                                : undefined
                        }
                        className='font-semibold text-slate-100'
                    >
                        {feature.name}
                    </label>
                    <div className='mt-2 flex flex-wrap gap-2'>
                        <Badge
                            variant='outline'
                            className='font-mono text-[10px]'
                        >
                            {feature.key}
                        </Badge>
                        {feature.isActive ? null : (
                            <Badge variant='destructive'>
                                {tr('globallyDisabled')}
                            </Badge>
                        )}
                    </div>
                </div>
                {onToggle ? (
                    <Checkbox
                        id={`legacy-feature-${feature.id}`}
                        checked={selected === true}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                            onToggle(checked === true)
                        }
                        className='mt-1 shrink-0'
                    />
                ) : null}
            </div>
            <p className='mt-3 text-sm leading-5 text-slate-500'>
                {feature.description ?? tr('noDescription')}
            </p>
            {feature.override?.expiresAt ? (
                <p className='mt-3 text-xs text-amber-200'>
                    {tr('overrideUntil', {
                        date: format.dateTime(
                            new Date(feature.override.expiresAt),
                            { dateStyle: 'medium', timeStyle: 'short' }
                        ),
                    })}
                </p>
            ) : null}
            <p className='mt-4 border-t border-white/8 pt-3 text-xs text-slate-400'>
                {selected === undefined
                    ? feature.enabled
                        ? tr('moduleAvailable')
                        : tr('moduleDisabled')
                    : selected
                      ? feature.isActive
                          ? tr('selected')
                          : tr('selectedGloballyDisabled')
                      : tr('notSelected')}
            </p>
        </div>
    );
}
