'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { Box, BrainCircuit, Hash, Layers3 } from 'lucide-react';
import { ProfileSummary } from './profile-summary';
import type { Collection } from '../types';

const strategyKeys = {
    DOCUMENT_STRUCTURE: 'profile.structure',
    TOKEN_WINDOW: 'profile.tokens',
    SEMANTIC: 'profile.semantic',
} as const;

/** Keep the saved profile legible while retaining its full binding and revision details. */
export function CollectionOverview({
    collection,
}: Readonly<{ collection: Collection }>) {
    const tr = useTranslations('rag');
    const format = useFormatter();
    const profile = collection.configuration;
    const facts = [
        {
            label: tr('profile.model'),
            value: profile.model,
            detail: profile.provider,
            icon: BrainCircuit,
            tone: 'blue',
        },
        {
            label: tr('profile.chunking'),
            value: tr(strategyKeys[profile.chunkingStrategy]),
            detail: tr('profile.tokenPair', {
                first: profile.chunking.targetTokens,
                second: profile.chunking.overlapTokens,
            }),
            icon: Layers3,
            tone: 'teal',
        },
        {
            label: tr('profile.dimensions'),
            value: format.number(profile.dimensions),
            detail: profile.indexType,
            icon: Box,
            tone: 'blue',
        },
        {
            label: tr('collections.revisionLabel'),
            value: format.number(collection.configurationRevision),
            detail: null,
            icon: Hash,
            tone: 'teal',
        },
    ] as const;
    return (
        <section className='space-y-5'>
            <dl className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
                {facts.map((fact) => (
                    <div
                        key={fact.label}
                        className='vectorix-fact-card rounded-xl border bg-card p-4'
                        data-tone={fact.tone}
                    >
                        <div className='mb-3 flex items-center gap-2'>
                            <span className='vectorix-icon-tile inline-flex size-8 items-center justify-center rounded-lg'>
                                <fact.icon className='size-4' aria-hidden />
                            </span>
                            <dt className='text-sm text-muted-foreground'>
                                {fact.label}
                            </dt>
                        </div>
                        <dd>
                            <p className='break-words font-semibold'>
                                {fact.value}
                            </p>
                            {fact.detail && (
                                <p className='mt-1 text-xs leading-relaxed text-muted-foreground'>
                                    {fact.detail}
                                </p>
                            )}
                        </dd>
                    </div>
                ))}
            </dl>
            <p className='text-sm text-muted-foreground'>
                {tr('indexing.rebuild.savedProfileHint')}
            </p>
            <details className='rounded-xl border bg-card p-5'>
                <summary className='cursor-pointer font-medium text-primary dark:text-accent-foreground'>
                    {tr('collections.profileDetails')}
                </summary>
                <div className='mt-5 border-t pt-5'>
                    <h3 className='mb-2 font-semibold'>
                        {tr('indexing.rebuild.savedProfile', {
                            revision: collection.configurationRevision,
                        })}
                    </h3>
                    <ProfileSummary configuration={profile} />
                </div>
            </details>
        </section>
    );
}
