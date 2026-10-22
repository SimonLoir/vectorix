'use client';
import { useId, useState } from 'react';
import { Label } from '@repo/ui/label';
import { ActivityTotals } from './activity-counters';
import {
    activityNumber,
    type ActivityDimension,
    type ActivityFormatting,
} from './types';

function PhaseTable({
    dimension,
    locale,
    text,
}: Readonly<{ dimension: ActivityDimension }> &
    Pick<ActivityFormatting, 'locale' | 'text'>) {
    const quantile = (value: ActivityDimension['phases'][number]['p95']) =>
        value.upperMicros === null
            ? text('tailBound', {
                  from: activityNumber(value.lowerMicros, locale),
              })
            : text('rangeBound', {
                  from: activityNumber(value.lowerMicros, locale),
                  to: activityNumber(value.upperMicros, locale),
              });
    return dimension.phases.length ? (
        <div
            className='max-h-[60vh] overflow-auto rounded-md border'
            tabIndex={0}
            role='region'
            aria-label={text('phasesTitle')}
        >
            <table className='w-full min-w-[52rem] text-left text-sm'>
                <caption className='sr-only'>{text('phaseHint')}</caption>
                <thead>
                    <tr className='border-b'>
                        {[
                            'phase',
                            'samples',
                            'mean',
                            'maximum',
                            'p50',
                            'p95',
                            'total',
                        ].map((key) => (
                            <th scope='col' className='p-3' key={key}>
                                {text(key)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {dimension.phases.map((phase) => (
                        <tr key={phase.name} className='border-b last:border-0'>
                            <th scope='row' className='p-3 font-medium'>
                                {text(`phases.${phase.name}`)}
                            </th>
                            <td className='p-3 tabular-nums'>
                                {activityNumber(phase.samples, locale)}
                            </td>
                            <td className='p-3 tabular-nums'>
                                {text('micros', {
                                    value: activityNumber(
                                        phase.meanMicros,
                                        locale
                                    ),
                                })}
                            </td>
                            <td className='p-3 tabular-nums'>
                                {text('micros', {
                                    value: activityNumber(
                                        phase.maxMicros,
                                        locale
                                    ),
                                })}
                            </td>
                            <td className='p-3'>{quantile(phase.p50)}</td>
                            <td className='p-3'>{quantile(phase.p95)}</td>
                            <td className='p-3 tabular-nums'>
                                {text('micros', {
                                    value: activityNumber(
                                        phase.totalMicros,
                                        locale
                                    ),
                                })}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    ) : (
        <p className='text-sm text-muted-foreground'>{text('noPhases')}</p>
    );
}

/** Only the bounded 27 public workload/provider combinations are filtered locally. */
export function ActivityDimensions({
    dimensions,
    ...formatting
}: Readonly<{ dimensions: ActivityDimension[] }> & ActivityFormatting) {
    const { text, locale } = formatting;
    const [workload, setWorkload] = useState('ALL');
    const [provider, setProvider] = useState('ALL');
    const id = useId();
    const currentWorkload = dimensions.some(
        (item) => item.workload === workload
    )
        ? workload
        : 'ALL';
    const currentProvider = dimensions.some(
        (item) => item.provider === provider
    )
        ? provider
        : 'ALL';
    const filtered = dimensions.filter(
        (item) =>
            (currentWorkload === 'ALL' || item.workload === currentWorkload) &&
            (currentProvider === 'ALL' || item.provider === currentProvider)
    );
    const selectors = [
        {
            key: 'workload',
            value: currentWorkload,
            set: setWorkload,
            values: [...new Set(dimensions.map((item) => item.workload))],
        },
        {
            key: 'provider',
            value: currentProvider,
            set: setProvider,
            values: [...new Set(dimensions.map((item) => item.provider))],
        },
    ];
    return (
        <section className='space-y-4'>
            <h3 className='font-semibold'>{text('dimensionsTitle')}</h3>
            <div className='flex flex-wrap gap-4'>
                {selectors.map((select) => (
                    <div className='space-y-2' key={select.key}>
                        <Label htmlFor={`${id}-${select.key}`}>
                            {text(select.key)}
                        </Label>
                        <select
                            id={`${id}-${select.key}`}
                            className='h-10 w-full rounded-md border border-input bg-background px-3 text-sm'
                            value={select.value}
                            onChange={(event) => select.set(event.target.value)}
                        >
                            <option value='ALL'>{text('all')}</option>
                            {select.values.map((value) => (
                                <option key={value} value={value}>
                                    {text(`${select.key}s.${value}`)}
                                </option>
                            ))}
                        </select>
                    </div>
                ))}
            </div>
            <p className='text-xs text-muted-foreground'>{text('phaseHint')}</p>
            <p className='text-xs text-muted-foreground'>
                {text('internalHint')}
            </p>
            {filtered.length === 0 && <p>{text('noDimensions')}</p>}
            {filtered.map((dimension) => (
                <details
                    className='space-y-5 rounded-lg border p-4'
                    key={`${dimension.workload}-${dimension.provider}`}
                >
                    <summary className='cursor-pointer font-medium'>
                        {text('dimension', {
                            workload: text(`workloads.${dimension.workload}`),
                            provider: text(`providers.${dimension.provider}`),
                        })}
                    </summary>
                    <ActivityTotals
                        counters={dimension.counters}
                        {...formatting}
                    />
                    <PhaseTable dimension={dimension} {...formatting} />
                    <div className='space-y-2'>
                        <h4 className='font-medium'>{text('failuresTitle')}</h4>
                        {dimension.failures.length ? (
                            <dl className='grid gap-3 sm:grid-cols-3'>
                                {dimension.failures.map((failure) => (
                                    <div key={failure.code}>
                                        <dt className='text-sm text-muted-foreground'>
                                            {text(`failures.${failure.code}`)}
                                        </dt>
                                        <dd>
                                            {activityNumber(
                                                failure.count,
                                                locale
                                            )}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        ) : (
                            <p className='text-sm text-muted-foreground'>
                                {text('noFailures')}
                            </p>
                        )}
                    </div>
                </details>
            ))}
        </section>
    );
}
