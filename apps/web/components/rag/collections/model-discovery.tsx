'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { Button } from '@repo/ui/button';
import { IndexError, useIndexAction } from '../indexing/index-state';
import type { RagOutputs } from '../types';

export function ModelDiscovery({
    collectionId,
    onSelect,
    saved,
    selected,
}: Readonly<{
    collectionId: string;
    onSelect: (model: string) => void;
    saved: { provider: string; model: string; revision: number };
    selected: { provider: string; model: string };
}>) {
    const tr = useTranslations('rag.indexing');
    const { client } = useORPC();
    const action = useIndexAction();
    const { canOperation } = useVectorixPermissions();
    const [models, setModels] = useState<
        RagOutputs['indexing']['models'] | null
    >(null);
    const matchesSaved =
        saved.provider === selected.provider && saved.model === selected.model;
    const supported =
        saved.provider === 'OLLAMA' ||
        saved.provider === 'COHERE' ||
        saved.provider === 'VOYAGE' ||
        saved.provider === 'OPENAI';
    if (!canOperation('admin.rag.indexing.models')) return null;
    return (
        <div className='space-y-3 sm:col-span-2'>
            <Button
                type='button'
                variant='outline'
                disabled={action.busy || !matchesSaved || !supported}
                onClick={() =>
                    void action.run(
                        () =>
                            client.admin.rag.indexing.models({
                                collectionId,
                                expectedRevision: saved.revision,
                            }),
                        setModels,
                        false
                    )
                }
            >
                {action.busy
                    ? tr('discovering')
                    : tr(
                          saved.provider === 'VOYAGE'
                              ? 'reviewedModels'
                              : 'discoverModels'
                      )}
            </Button>
            <p className='text-xs text-muted-foreground'>
                {tr('savedDiscoveryHint', {
                    revision: saved.revision,
                    provider: saved.provider,
                })}
            </p>
            {!matchesSaved && (
                <p role='status' className='text-xs text-muted-foreground'>
                    {tr('discoverySaveFirst')}
                </p>
            )}
            <p className='text-xs text-muted-foreground'>
                {tr('discoveryHint')}
            </p>
            {models?.reviewedCatalog && matchesSaved && (
                <p className='text-xs text-muted-foreground'>
                    {tr('reviewedCatalogHint')}
                </p>
            )}
            {models?.discoverySource && matchesSaved && (
                <p className='text-xs text-muted-foreground'>
                    {tr(`discoverySources.${models.discoverySource}`)}
                </p>
            )}
            <IndexError error={action.error} />
            {models && matchesSaved && supported && (
                <div className='max-h-48 space-y-2 overflow-auto rounded-lg border p-3'>
                    {models.items.length === 0 ? (
                        <p>{tr('noModels')}</p>
                    ) : (
                        models.items.map((model) => (
                            <Button
                                key={model.model}
                                type='button'
                                variant='ghost'
                                className='h-auto w-full justify-start whitespace-normal break-all text-left'
                                onClick={() => onSelect(model.model)}
                            >
                                {model.model} · {model.family}
                            </Button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
