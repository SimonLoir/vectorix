'use client';
import { useFormatter, useTranslations } from 'next-intl';
import type { Collection } from '../types';
const strategyKeys = {
    DOCUMENT_STRUCTURE: 'profile.structure',
    TOKEN_WINDOW: 'profile.tokens',
    SEMANTIC: 'profile.semantic',
} as const;
export function ProfileSummary({
    configuration: c,
}: Readonly<{ configuration: Collection['configuration'] }>) {
    const tr = useTranslations('rag');
    const format = useFormatter();
    const fields = [
        ['profile.providerLabel', c.provider],
        ['profile.model', c.model],
        ['indexing.preset', tr(`indexing.presets.${c.embeddingPreset}`)],
        ['profile.dimensions', format.number(c.dimensions)],
        ['profile.index', `${c.indexType} · ${c.metric} · ${c.numericType}`],
        ['profile.chunking', tr(strategyKeys[c.chunkingStrategy])],
        [
            'profile.parentChildSummary',
            tr(c.parentChild ? 'common.enabled' : 'common.disabled'),
        ],
        [
            'profile.targetOverlap',
            tr('profile.tokenPair', {
                first: c.chunking.targetTokens,
                second: c.chunking.overlapTokens,
            }),
        ],
        [
            'profile.bounds',
            tr('profile.tokenPair', {
                first: c.chunking.minTokens,
                second: c.chunking.maxTokens,
            }),
        ],
        [
            'profile.threshold',
            tr('profile.percentileValue', {
                value: c.chunking.semanticPercentile,
            }),
        ],
        [
            'profile.parentLimit',
            tr('profile.tokenCount', { count: c.chunking.parentMaxTokens }),
        ],
    ] as const;
    return (
        <div className='space-y-4 text-sm'>
            {c.chunkingStrategy === 'TOKEN_WINDOW' && (
                <div className='space-y-2 text-muted-foreground'>
                    <p>
                        {tr('profile.tokenEstimationHint', {
                            bytesPerToken: 3,
                        })}
                    </p>
                    <p>{tr('profile.tokenWindowHint')}</p>
                </div>
            )}
            {(c.chunkingStrategy === 'SEMANTIC' || c.parentChild) && (
                <p role='status' className='rounded-lg border p-3'>
                    {tr('profile.plannedChunkingHint')}
                </p>
            )}
            <dl className='grid gap-4 sm:grid-cols-2'>
                {fields.map(([key, value]) => (
                    <div key={key}>
                        <dt className='text-muted-foreground'>{tr(key)}</dt>
                        <dd className='mt-1 font-medium break-words'>
                            {value}
                        </dd>
                    </div>
                ))}
                <div className='sm:col-span-2'>
                    <dt className='text-muted-foreground'>
                        {tr('profile.binding')}
                    </dt>
                    <dd className='mt-1 break-all'>
                        {c.credentialId
                            ? tr('profile.organizationBinding', {
                                  id: c.credentialId,
                                  revision:
                                      c.credentialRevision === null
                                          ? '—'
                                          : format.number(c.credentialRevision),
                              })
                            : tr('profile.platformConfiguration')}
                    </dd>
                </div>
                <div className='sm:col-span-2'>
                    <dt className='text-muted-foreground'>
                        {tr('profile.destination')}
                    </dt>
                    <dd className='mt-1 break-all'>
                        {tr('profile.platformDestination', {
                            id: c.vectorConnectionId,
                        })}
                    </dd>
                </div>
            </dl>
            {Object.keys(c.metadataFields).length > 0 && (
                <div>
                    <h3 className='text-muted-foreground'>
                        {tr('indexing.metadataFields')}
                    </h3>
                    <dl className='mt-2 flex flex-wrap gap-3'>
                        {Object.entries(c.metadataFields).map(([key, type]) => (
                            <div key={key}>
                                <dt>{key}</dt>
                                <dd>{tr(`indexing.fieldTypes.${type}`)}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}
            {c.preparation && (
                <div>
                    <h3 className='text-muted-foreground'>
                        {tr('profile.preparationSummary')}
                    </h3>
                    <p className='mt-1 whitespace-pre-wrap break-words'>
                        {c.preparation}
                    </p>
                </div>
            )}
        </div>
    );
}
