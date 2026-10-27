'use client';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { listRerankingModels } from '@repo/reranking/models';
import { SelectField, TextField } from '../form-fields';

export const TEI_MODEL_SUGGESTIONS = [
    'BAAI/bge-reranker-v2-m3',
    'Alibaba-NLP/gte-multilingual-reranker-base',
] as const;

/** Suggestions are local identifiers only; selection never installs a model or queries a runtime. */
export function defaultRerankingModel(provider: string) {
    if (provider === 'TEI') return TEI_MODEL_SUGGESTIONS[0];
    return provider === 'COHERE' || provider === 'VOYAGE'
        ? listRerankingModels(provider)[0]!.id
        : '';
}

export function ProfileModelFields({
    provider,
    model,
    onProviderChange,
    onModelChange,
}: Readonly<{
    provider: string;
    model: string;
    onProviderChange: (provider: 'COHERE' | 'VOYAGE' | 'TEI') => void;
    onModelChange: (model: string) => void;
}>) {
    const tr = useTranslations('rag.reranking');
    const suggestionsId = useId();
    const models =
        provider === 'COHERE' || provider === 'VOYAGE'
            ? listRerankingModels(provider)
            : [];
    const hosted = provider === 'COHERE' || provider === 'VOYAGE';
    return (
        <>
            <div className='grid gap-4 sm:grid-cols-2'>
                <SelectField
                    label={tr('provider')}
                    value={provider}
                    onChange={(event) => {
                        const value = event.target.value;
                        if (
                            value === 'COHERE' ||
                            value === 'VOYAGE' ||
                            value === 'TEI'
                        )
                            onProviderChange(value);
                    }}
                >
                    {!hosted && provider !== 'TEI' && (
                        <option value={provider}>{provider}</option>
                    )}
                    <option value='COHERE'>Cohere</option>
                    <option value='VOYAGE'>Voyage</option>
                    <option value='TEI'>{tr('selfHosted.provider')}</option>
                </SelectField>
                {hosted ? (
                    <SelectField
                        label={tr('model')}
                        value={model}
                        onChange={(event) => onModelChange(event.target.value)}
                    >
                        {!models.some((value) => value.id === model) && (
                            <option value={model}>{model}</option>
                        )}
                        {models.map((value) => (
                            <option key={value.id} value={value.id}>
                                {value.id}
                            </option>
                        ))}
                    </SelectField>
                ) : (
                    <div className='space-y-2'>
                        <TextField
                            label={tr('model')}
                            value={model}
                            onChange={(event) =>
                                onModelChange(event.target.value)
                            }
                            required
                            maxLength={200}
                            list={suggestionsId}
                            autoComplete='off'
                        />
                        {provider === 'TEI' && (
                            <datalist id={suggestionsId}>
                                {TEI_MODEL_SUGGESTIONS.map((value) => (
                                    <option key={value} value={value} />
                                ))}
                            </datalist>
                        )}
                    </div>
                )}
            </div>
            {provider === 'TEI' && (
                <p className='text-xs text-muted-foreground'>
                    {tr('selfHosted.modelHint')}
                </p>
            )}
        </>
    );
}
