'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SelectField, TextField } from '../form-fields';
import { ModelDiscovery } from './model-discovery';
import { hostedModelCatalog } from './hosted-model-catalog';
import type { Collection } from '../types';

type Configuration = Collection['configuration'];
type Provider = Configuration['provider'];
interface EmbeddingDraft {
    provider: Provider;
    model: string;
    dimensions: string;
    preset: Configuration['embeddingPreset'];
}
function initialDraft(configuration?: Configuration): EmbeddingDraft {
    return {
        provider: configuration?.provider ?? 'OLLAMA',
        model: configuration?.model ?? 'embeddinggemma',
        dimensions: String(configuration?.dimensions ?? 768),
        preset: configuration?.embeddingPreset ?? 'GENERIC',
    };
}

/** Keep unsaved provider/model choices separate from discovery of a saved credential binding. */
export function EmbeddingFields({
    configuration,
    collectionId,
    configurationRevision,
}: Readonly<{
    configuration?: Configuration;
    collectionId?: string;
    configurationRevision?: number;
}>) {
    const tr = useTranslations('rag');
    const [draft, setDraft] = useState(() => initialDraft(configuration));
    const catalog = hostedModelCatalog(draft.provider);
    const hosted = catalog !== null;
    const voyage = draft.provider === 'VOYAGE';
    const supportedModel = catalog?.models.find(
        (item) => item.model === draft.model
    );
    const executable = draft.provider === 'OLLAMA' || hosted;
    function selectModel(model: string) {
        setDraft((current) => {
            const next = hostedModelCatalog(current.provider)?.models.find(
                (item) => item.model === model
            );
            return {
                ...current,
                model,
                ...(next
                    ? {
                          dimensions: String(
                              next.dimensions.includes(
                                  Number(current.dimensions)
                              )
                                  ? Number(current.dimensions)
                                  : next.defaultDimensions
                          ),
                          preset: 'GENERIC' as const,
                      }
                    : {}),
            };
        });
    }
    function selectProvider(provider: Provider) {
        if (provider === draft.provider) return;
        if (provider === configuration?.provider) {
            setDraft(initialDraft(configuration));
            return;
        }
        const defaultModel = hostedModelCatalog(provider)?.models[0];
        setDraft(
            defaultModel
                ? {
                      provider,
                      model: defaultModel.model,
                      dimensions: String(defaultModel.defaultDimensions),
                      preset: 'GENERIC',
                  }
                : provider === 'OLLAMA'
                  ? initialDraft()
                  : { provider, model: '', dimensions: '', preset: 'GENERIC' }
        );
    }
    return (
        <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
                <SelectField
                    label={tr('profile.provider')}
                    name='provider'
                    value={draft.provider}
                    onChange={(event) => {
                        const provider = event.target.value;
                        if (
                            provider === 'OLLAMA' ||
                            provider === 'COHERE' ||
                            provider === 'VOYAGE' ||
                            provider === 'OPENAI' ||
                            provider === 'MISTRAL'
                        )
                            selectProvider(provider);
                    }}
                >
                    <option value='OLLAMA'>Ollama</option>
                    <option value='COHERE'>Cohere</option>
                    <option value='VOYAGE'>Voyage</option>
                    <option value='OPENAI'>OpenAI</option>
                    <option value='MISTRAL'>Mistral</option>
                </SelectField>
                {catalog ? (
                    <SelectField
                        label={tr('profile.model')}
                        name='model'
                        value={draft.model}
                        onChange={(event) => selectModel(event.target.value)}
                    >
                        {!supportedModel && (
                            <option value={draft.model}>
                                {tr('indexing.savedUnsupportedModel', {
                                    model: draft.model,
                                })}
                            </option>
                        )}
                        {catalog.models.map((item) => (
                            <option key={item.model} value={item.model}>
                                {item.model}
                            </option>
                        ))}
                    </SelectField>
                ) : (
                    <TextField
                        label={tr('profile.model')}
                        name='model'
                        required
                        maxLength={200}
                        value={draft.model}
                        onChange={(event) => selectModel(event.target.value)}
                        placeholder={tr('profile.modelPlaceholder')}
                    />
                )}
            </div>
            {hosted && (
                <p className='text-sm text-muted-foreground'>
                    {tr(
                        voyage
                            ? 'indexing.voyageCatalogHint'
                            : 'indexing.cohereCatalogHint'
                    )}
                </p>
            )}
            {!executable && (
                <p role='status' className='rounded-lg border p-3 text-sm'>
                    {tr('indexing.providerDraftOnly', {
                        provider: draft.provider,
                    })}
                </p>
            )}
            {collectionId &&
                configuration &&
                configurationRevision !== undefined && (
                    <ModelDiscovery
                        key={`${configurationRevision}:${configuration.provider}:${configuration.model}`}
                        collectionId={collectionId}
                        saved={{
                            provider: configuration.provider,
                            model: configuration.model,
                            revision: configurationRevision,
                        }}
                        selected={{
                            provider: draft.provider,
                            model: draft.model,
                        }}
                        onSelect={selectModel}
                    />
                )}
            <SelectField
                label={tr('indexing.preset')}
                name='embeddingPreset'
                value={draft.preset}
                onChange={(event) => {
                    const preset = event.target.value;
                    if (
                        preset === 'GENERIC' ||
                        (preset === 'EMBEDDING_GEMMA' && !hosted)
                    )
                        setDraft((current) => ({ ...current, preset }));
                }}
            >
                <option value='GENERIC'>
                    {tr('indexing.presets.GENERIC')}
                </option>
                {(!hosted || draft.preset === 'EMBEDDING_GEMMA') && (
                    <option value='EMBEDDING_GEMMA'>
                        {tr(
                            hosted
                                ? 'indexing.savedUnsupportedPreset'
                                : 'indexing.presets.EMBEDDING_GEMMA'
                        )}
                    </option>
                )}
            </SelectField>
            <p className='text-sm text-muted-foreground'>
                {tr(
                    hosted
                        ? voyage
                            ? 'indexing.voyagePresetHint'
                            : 'indexing.coherePresetHint'
                        : 'indexing.presetHint'
                )}
            </p>
            {hosted && draft.preset !== 'GENERIC' && (
                <p role='status' className='text-sm'>
                    {tr(
                        voyage
                            ? 'indexing.voyageUnsupportedPresetHint'
                            : 'indexing.cohereUnsupportedPresetHint'
                    )}
                </p>
            )}
            {hosted && supportedModel ? (
                <SelectField
                    label={tr('profile.dimensions')}
                    name='dimensions'
                    value={draft.dimensions}
                    onChange={(event) =>
                        setDraft((current) => ({
                            ...current,
                            dimensions: event.target.value,
                        }))
                    }
                >
                    {!supportedModel.dimensions.includes(
                        Number(draft.dimensions)
                    ) && (
                        <option value={draft.dimensions}>
                            {tr('indexing.savedUnsupportedDimensions', {
                                count: Number(draft.dimensions),
                            })}
                        </option>
                    )}
                    {supportedModel.dimensions.map((value) => (
                        <option key={value} value={value}>
                            {tr('indexing.dimensions', { count: value })}
                        </option>
                    ))}
                </SelectField>
            ) : (
                <TextField
                    label={tr('profile.dimensions')}
                    name='dimensions'
                    type='number'
                    required
                    min={1}
                    max={16_000}
                    value={draft.dimensions}
                    onChange={(event) =>
                        setDraft((current) => ({
                            ...current,
                            dimensions: event.target.value,
                        }))
                    }
                />
            )}
        </div>
    );
}
