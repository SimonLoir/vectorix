'use client';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { SelectField, TextField, CheckField } from '../form-fields';
import { MetadataFields } from './metadata-fields';
import { EmbeddingFields } from './embedding-fields';
import { ProfileDraftSummary } from './profile-draft-summary';
import type { Collection } from '../types';
import type { ProfileDraft, Provider } from './profile-draft';

export type ProfileSection = 'embedding' | 'chunking' | 'metadata';
export function ProfileFields({
    draft,
    onPatch,
    onSelect,
    advanced,
    section,
    configuration,
    collectionId,
    configurationRevision,
}: Readonly<{
    draft: ProfileDraft;
    onPatch: (patch: Partial<ProfileDraft>) => void;
    onSelect: (provider: Provider, model: string) => void;
    advanced: boolean;
    section: ProfileSection;
    configuration?: Collection['configuration'];
    collectionId?: string;
    configurationRevision?: number;
}>) {
    const tr = useTranslations('rag');
    const estimateId = useId();
    if (!advanced || section === 'embedding')
        return (
            <div className='space-y-4'>
                <EmbeddingFields
                    draft={draft}
                    onPatch={onPatch}
                    onSelect={onSelect}
                    advanced={advanced}
                    configuration={configuration}
                    collectionId={collectionId}
                    configurationRevision={configurationRevision}
                />
                {!advanced && <ProfileDraftSummary draft={draft} recommended />}
            </div>
        );
    if (section === 'metadata')
        return (
            <MetadataFields
                rows={draft.metadataRows}
                onChange={(metadataRows) => onPatch({ metadataRows })}
            />
        );
    return (
        <div className='space-y-4'>
            <SelectField
                label={tr('profile.chunking')}
                name='chunkingStrategy'
                value={draft.chunkingStrategy}
                onChange={(event) => {
                    const strategy = event.target.value;
                    if (
                        strategy === 'DOCUMENT_STRUCTURE' ||
                        strategy === 'TOKEN_WINDOW' ||
                        strategy === 'SEMANTIC'
                    )
                        onPatch({ chunkingStrategy: strategy });
                }}
            >
                <option value='DOCUMENT_STRUCTURE'>
                    {tr('profile.structure')}
                </option>
                <option value='TOKEN_WINDOW'>{tr('profile.tokens')}</option>
                <option value='SEMANTIC'>{tr('profile.semantic')}</option>
            </SelectField>
            <p
                id={estimateId}
                className='rounded-lg bg-info/5 p-3 text-xs leading-relaxed text-muted-foreground'
            >
                {tr('profile.tokenEstimationHint', { bytesPerToken: 3 })}
            </p>
            {draft.chunkingStrategy === 'TOKEN_WINDOW' && (
                <p className='text-xs text-muted-foreground'>
                    {tr('profile.tokenWindowTailHint')}
                </p>
            )}
            <div className='grid gap-4 sm:grid-cols-2'>
                {(
                    [
                        'targetTokens',
                        'overlapTokens',
                        'minTokens',
                        'maxTokens',
                    ] as const
                ).map((key, index) => (
                    <TextField
                        key={key}
                        label={tr(
                            [
                                'profile.target',
                                'profile.overlap',
                                'profile.minimum',
                                'profile.maximum',
                            ][index]!
                        )}
                        name={key}
                        type='number'
                        min={key === 'overlapTokens' ? 0 : 1}
                        max={key === 'maxTokens' ? 16_384 : 8192}
                        aria-describedby={estimateId}
                        value={draft[key]}
                        onChange={(event) =>
                            onPatch({ [key]: event.target.value })
                        }
                    />
                ))}
            </div>
            {draft.chunkingStrategy === 'SEMANTIC' && (
                <section className='space-y-3 rounded-lg border border-info/20 bg-info/5 p-4'>
                    <TextField
                        label={tr('profile.percentile')}
                        name='semanticPercentile'
                        type='number'
                        min={1}
                        max={99}
                        value={draft.semanticPercentile}
                        onChange={(event) =>
                            onPatch({ semanticPercentile: event.target.value })
                        }
                    />
                    <p className='text-xs text-muted-foreground'>
                        {tr('profile.semanticWorkHint')}
                    </p>
                </section>
            )}
            <CheckField
                label={tr('profile.parentChild')}
                name='parentChild'
                checked={draft.parentChild}
                onChange={(event) =>
                    onPatch({ parentChild: event.target.checked })
                }
            />
            {draft.parentChild && (
                <section className='space-y-3 rounded-lg border border-info/20 bg-info/5 p-4'>
                    <TextField
                        label={tr('profile.parentMaximum')}
                        name='parentMaxTokens'
                        type='number'
                        min={Math.max(32, Number(draft.maxTokens))}
                        max={32_768}
                        value={draft.parentMaxTokens}
                        onChange={(event) =>
                            onPatch({ parentMaxTokens: event.target.value })
                        }
                    />
                    <p className='text-xs text-muted-foreground'>
                        {tr('profile.parentContextHint')}
                    </p>
                    <p className='text-xs text-muted-foreground'>
                        {tr('profile.parentSizeHint', {
                            maxBytes: 49_152,
                            bytesPerToken: 3,
                        })}
                    </p>
                </section>
            )}
        </div>
    );
}
