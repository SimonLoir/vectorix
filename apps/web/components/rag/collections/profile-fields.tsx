'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { TextField, SelectField, CheckField, AreaField } from '../form-fields';
import type { Collection } from '../types';

export function ProfileFields({
    configuration,
}: Readonly<{ configuration?: Collection['configuration'] }>) {
    const tr = useTranslations('rag');
    const [strategy, setStrategy] = useState(
        configuration?.chunkingStrategy ?? 'DOCUMENT_STRUCTURE'
    );
    const [parent, setParent] = useState(configuration?.parentChild ?? false);
    return (
        <div className='space-y-5'>
            <div className='grid gap-4 sm:grid-cols-2'>
                <SelectField
                    label={tr('profile.provider')}
                    name='provider'
                    defaultValue={configuration?.provider ?? 'OLLAMA'}
                >
                    <option value='OLLAMA'>Ollama</option>
                    <option value='COHERE'>Cohere</option>
                    <option value='VOYAGE'>Voyage</option>
                    <option value='OPENAI'>OpenAI</option>
                    <option value='MISTRAL'>Mistral</option>
                </SelectField>
                <TextField
                    label={tr('profile.model')}
                    name='model'
                    required
                    maxLength={200}
                    defaultValue={configuration?.model}
                    placeholder={tr('profile.modelPlaceholder')}
                />
            </div>
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label={tr('profile.dimensions')}
                    name='dimensions'
                    type='number'
                    required
                    min={1}
                    max={16_000}
                    defaultValue={configuration?.dimensions}
                />
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
            <SelectField
                label={tr('profile.chunking')}
                name='chunkingStrategy'
                value={strategy}
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
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label={tr('profile.target')}
                    name='targetTokens'
                    type='number'
                    required
                    min={32}
                    max={8192}
                    defaultValue={configuration?.chunking.targetTokens ?? 512}
                />
                <TextField
                    label={tr('profile.overlap')}
                    name='overlapTokens'
                    type='number'
                    required
                    min={0}
                    max={4096}
                    defaultValue={configuration?.chunking.overlapTokens ?? 64}
                />
                <TextField
                    label={tr('profile.minimum')}
                    name='minTokens'
                    type='number'
                    required
                    min={1}
                    max={8192}
                    defaultValue={configuration?.chunking.minTokens ?? 128}
                />
                <TextField
                    label={tr('profile.maximum')}
                    name='maxTokens'
                    type='number'
                    required
                    min={32}
                    max={16_384}
                    defaultValue={configuration?.chunking.maxTokens ?? 768}
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
