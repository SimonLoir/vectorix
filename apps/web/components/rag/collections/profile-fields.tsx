'use client';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { TextField, SelectField, CheckField, AreaField } from '../form-fields';
import { MetadataFields } from './metadata-fields';
import { EmbeddingFields } from './embedding-fields';
import type { Collection } from '../types';

export function ProfileFields({
    configuration,
    collectionId,
    configurationRevision,
}: Readonly<{
    configuration?: Collection['configuration'];
    collectionId?: string;
    configurationRevision?: number;
}>) {
    const tr = useTranslations('rag');
    const [strategy, setStrategy] = useState(
        configuration?.chunkingStrategy ?? 'DOCUMENT_STRUCTURE'
    );
    const [parent, setParent] = useState(configuration?.parentChild ?? false);
    const estimateHintId = useId();
    const windowHintId = useId();
    const tailHintId = useId();
    const plannedHintId = useId();
    const planned = strategy === 'SEMANTIC' || parent;
    return (
        <div className='space-y-5'>
            <EmbeddingFields
                configuration={configuration}
                collectionId={collectionId}
                configurationRevision={configurationRevision}
            />
            <p className='text-sm text-muted-foreground'>
                {tr('indexing.profileGate')}
            </p>
            <div className='grid gap-4 sm:grid-cols-2'>
                <SelectField
                    label={tr('profile.index')}
                    name='indexType'
                    defaultValue={configuration?.indexType ?? 'DISKANN'}
                >
                    <option value='DISKANN'>DiskANN · pgvectorscale</option>
                    <option value='HNSW'>HNSW · pgvector</option>
                </SelectField>
            </div>
            <p className='text-sm text-muted-foreground'>
                {tr('profile.indexHint')}
            </p>
            <AreaField
                label={tr('profile.preparation')}
                name='preparation'
                maxLength={4000}
                defaultValue={configuration?.preparation ?? ''}
                rows={3}
            />
            <p className='text-xs text-muted-foreground'>
                {tr('indexing.preparationHint')}
            </p>
            <MetadataFields initial={configuration?.metadataFields} />
            <SelectField
                label={tr('profile.chunking')}
                name='chunkingStrategy'
                value={strategy}
                aria-describedby={[
                    estimateHintId,
                    ...(strategy === 'TOKEN_WINDOW' ? [windowHintId] : []),
                    ...(planned ? [plannedHintId] : []),
                ].join(' ')}
                onChange={(event) => {
                    const value = event.target.value;
                    if (
                        value === 'TOKEN_WINDOW' ||
                        value === 'DOCUMENT_STRUCTURE' ||
                        value === 'SEMANTIC'
                    )
                        setStrategy(value);
                }}
            >
                <option value='DOCUMENT_STRUCTURE'>
                    {tr('profile.structure')}
                </option>
                <option value='TOKEN_WINDOW'>{tr('profile.tokens')}</option>
                <option value='SEMANTIC'>{tr('profile.semantic')}</option>
            </SelectField>
            <p id={estimateHintId} className='text-sm text-muted-foreground'>
                {tr('profile.tokenEstimationHint', { bytesPerToken: 3 })}
            </p>
            {strategy === 'TOKEN_WINDOW' && (
                <div className='space-y-2 text-sm text-muted-foreground'>
                    <p id={windowHintId}>{tr('profile.tokenWindowHint')}</p>
                    <p id={tailHintId}>{tr('profile.tokenWindowTailHint')}</p>
                </div>
            )}
            {planned && (
                <p
                    id={plannedHintId}
                    role='status'
                    className='rounded-lg border p-3 text-sm'
                >
                    {tr('profile.plannedChunkingHint')}
                </p>
            )}
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label={tr('profile.target')}
                    name='targetTokens'
                    type='number'
                    required
                    min={32}
                    max={8192}
                    defaultValue={configuration?.chunking.targetTokens ?? 512}
                    aria-describedby={estimateHintId}
                />
                <TextField
                    label={tr('profile.overlap')}
                    name='overlapTokens'
                    type='number'
                    required
                    min={0}
                    max={4096}
                    defaultValue={configuration?.chunking.overlapTokens ?? 64}
                    aria-describedby={estimateHintId}
                />
                <TextField
                    label={tr('profile.minimum')}
                    name='minTokens'
                    type='number'
                    required
                    min={1}
                    max={8192}
                    defaultValue={configuration?.chunking.minTokens ?? 128}
                    aria-describedby={
                        strategy === 'TOKEN_WINDOW'
                            ? `${estimateHintId} ${tailHintId}`
                            : estimateHintId
                    }
                />
                <TextField
                    label={tr('profile.maximum')}
                    name='maxTokens'
                    type='number'
                    required
                    min={32}
                    max={16_384}
                    defaultValue={configuration?.chunking.maxTokens ?? 768}
                    aria-describedby={estimateHintId}
                />
            </div>
            <TextField
                label={tr('profile.percentile')}
                name='semanticPercentile'
                type='number'
                required
                min={1}
                max={99}
                defaultValue={configuration?.chunking.semanticPercentile ?? 90}
                readOnly={strategy !== 'SEMANTIC'}
            />
            <CheckField
                label={tr('profile.parentChild')}
                name='parentChild'
                checked={parent}
                onChange={(event) => setParent(event.target.checked)}
                aria-describedby={planned ? plannedHintId : undefined}
            />
            <TextField
                label={tr('profile.parentMaximum')}
                name='parentMaxTokens'
                type='number'
                required
                min={32}
                max={32_768}
                readOnly={!parent}
                defaultValue={configuration?.chunking.parentMaxTokens ?? 2048}
            />
        </div>
    );
}
