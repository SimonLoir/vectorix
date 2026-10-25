'use client';
import { useId } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
    listReviewedEmbeddingProfiles,
    getReviewedEmbeddingProfile,
    getRecommendedEmbeddingDefaults,
} from '@repo/embeddings/profiles';
import { SelectField, TextField, AreaField } from '../form-fields';
import { ModelDiscovery } from './model-discovery';
import type { Collection } from '../types';
import type { ProfileDraft, Provider } from './profile-draft';

type Props = Readonly<{
    draft: ProfileDraft;
    advanced: boolean;
    onPatch: (patch: Partial<ProfileDraft>) => void;
    onSelect: (provider: Provider, model: string) => void;
    configuration?: Collection['configuration'];
    collectionId?: string;
    configurationRevision?: number;
}>;

/** Display reviewed choices without importing native adapters or probing an unsaved credential binding. */
export function EmbeddingFields({
    draft,
    advanced,
    onPatch,
    onSelect,
    configuration,
    collectionId,
    configurationRevision,
}: Props) {
    const tr = useTranslations('rag');
    const format = useFormatter();
    const hintId = useId();
    const models = listReviewedEmbeddingProfiles(draft.provider);
    const reviewed = getReviewedEmbeddingProfile(draft.provider, draft.model);
    const recommendation = getRecommendedEmbeddingDefaults(
        draft.provider,
        draft.model
    );
    const range = reviewed?.dimensionCapability;
    const knownChoice =
        draft.provider === 'OLLAMA'
            ? Boolean(recommendation)
            : Boolean(reviewed);
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
                            onSelect(
                                provider,
                                listReviewedEmbeddingProfiles(provider)[0]
                                    ?.model ?? 'embeddinggemma'
                            );
                    }}
                >
                    <option value='OLLAMA'>Ollama</option>
                    <option value='COHERE'>Cohere</option>
                    <option value='VOYAGE'>Voyage</option>
                    <option value='OPENAI'>OpenAI</option>
                    <option value='MISTRAL'>Mistral</option>
                </SelectField>
                {draft.provider === 'OLLAMA' && advanced ? (
                    <TextField
                        label={tr('profile.model')}
                        name='model'
                        value={draft.model}
                        maxLength={200}
                        onChange={(event) =>
                            onPatch({ model: event.target.value })
                        }
                    />
                ) : (
                    <SelectField
                        label={tr('profile.model')}
                        name='model'
                        value={draft.model}
                        onChange={(event) =>
                            onSelect(draft.provider, event.target.value)
                        }
                    >
                        {!knownChoice && (
                            <option value={draft.model}>
                                {tr('indexing.savedUnsupportedModel', {
                                    model: draft.model,
                                })}
                            </option>
                        )}
                        {draft.provider === 'OLLAMA' ? (
                            <>
                                <option value='embeddinggemma'>
                                    EmbeddingGemma
                                </option>
                                <option value='embeddinggemma:latest'>
                                    embeddinggemma:latest
                                </option>
                            </>
                        ) : (
                            models.map((model) => (
                                <option key={model.model} value={model.model}>
                                    {model.model}
                                </option>
                            ))
                        )}
                    </SelectField>
                )}
            </div>
            <p className='rounded-lg border border-info/20 bg-info/5 p-3 text-xs leading-relaxed text-muted-foreground'>
                {tr('editor.recommendationHint')}
            </p>
            {advanced && (
                <>
                    <div className='grid gap-4 sm:grid-cols-2'>
                        {reviewed?.dimensions ? (
                            <SelectField
                                label={tr('profile.dimensions')}
                                name='dimensions'
                                value={draft.dimensions}
                                onChange={(event) =>
                                    onPatch({ dimensions: event.target.value })
                                }
                            >
                                {!reviewed.dimensions.includes(
                                    Number(draft.dimensions)
                                ) && (
                                    <option value={draft.dimensions}>
                                        {tr(
                                            'indexing.savedUnsupportedDimensions',
                                            { count: Number(draft.dimensions) }
                                        )}
                                    </option>
                                )}
                                {reviewed.dimensions.map((value) => (
                                    <option key={value} value={value}>
                                        {format.number(value)}
                                    </option>
                                ))}
                            </SelectField>
                        ) : (
                            <TextField
                                label={tr('profile.dimensions')}
                                name='dimensions'
                                type='number'
                                min={range?.minimum ?? 1}
                                max={range?.maximum ?? 16_000}
                                step={1}
                                value={draft.dimensions}
                                aria-describedby={hintId}
                                onChange={(event) =>
                                    onPatch({ dimensions: event.target.value })
                                }
                            />
                        )}
                        <SelectField
                            label={tr('profile.index')}
                            name='indexType'
                            value={draft.indexType}
                            onChange={(event) => {
                                if (
                                    event.target.value === 'HNSW' ||
                                    event.target.value === 'DISKANN'
                                )
                                    onPatch({ indexType: event.target.value });
                            }}
                        >
                            <option value='DISKANN'>
                                DiskANN · pgvectorscale
                            </option>
                            <option value='HNSW'>HNSW · pgvector</option>
                        </SelectField>
                    </div>
                    <p id={hintId} className='text-xs text-muted-foreground'>
                        {range
                            ? tr('editor.dimensionRange', {
                                  minimum: range.minimum,
                                  maximum: range.maximum,
                              })
                            : tr('editor.dimensionFixedHint')}{' '}
                        {tr('editor.hnswHint')}
                    </p>
                    <SelectField
                        label={tr('indexing.preset')}
                        name='embeddingPreset'
                        value={draft.embeddingPreset}
                        onChange={(event) => {
                            const preset = event.target.value;
                            if (
                                preset === 'GENERIC' ||
                                preset === 'EMBEDDING_GEMMA'
                            )
                                onPatch({ embeddingPreset: preset });
                        }}
                    >
                        <option value='GENERIC'>
                            {tr('indexing.presets.GENERIC')}
                        </option>
                        {(draft.provider === 'OLLAMA' ||
                            draft.embeddingPreset === 'EMBEDDING_GEMMA') && (
                            <option value='EMBEDDING_GEMMA'>
                                {tr('indexing.presets.EMBEDDING_GEMMA')}
                            </option>
                        )}
                    </SelectField>
                    <AreaField
                        label={tr('profile.preparation')}
                        name='preparation'
                        maxLength={4000}
                        rows={2}
                        value={draft.preparation}
                        onChange={(event) =>
                            onPatch({ preparation: event.target.value })
                        }
                    />
                    <p className='text-xs text-muted-foreground'>
                        {tr('indexing.preparationHint')}
                    </p>
                    {collectionId &&
                        configuration &&
                        configurationRevision !== undefined && (
                            <details className='rounded-lg border p-3'>
                                <summary className='cursor-pointer text-sm font-medium'>
                                    {tr('editor.discovery')}
                                </summary>
                                <div className='pt-3'>
                                    <ModelDiscovery
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
                                        onSelect={(model) =>
                                            onSelect(draft.provider, model)
                                        }
                                    />
                                </div>
                            </details>
                        )}
                </>
            )}
        </div>
    );
}
