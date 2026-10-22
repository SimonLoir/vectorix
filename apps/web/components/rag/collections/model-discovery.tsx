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
}: Readonly<{ collectionId: string; onSelect: (model: string) => void }>) {
    const tr = useTranslations('rag.indexing');
    const { client } = useORPC();
    const action = useIndexAction();
    const { canOperation } = useVectorixPermissions();
    const [models, setModels] = useState<
        RagOutputs['indexing']['models']['items'] | null
    >(null);
    if (!canOperation('admin.rag.indexing.models')) return null;
    return (
        <div className='space-y-3 sm:col-span-2'>
            <Button
                type='button'
                variant='outline'
                disabled={action.busy}
                onClick={() =>
                    void action.run(
                        () =>
                            client.admin.rag.indexing.models({ collectionId }),
                        (data) => setModels(data.items),
                        false
                    )
                }
            >
                {action.busy ? tr('discovering') : tr('discoverModels')}
            </Button>
            <p className='text-xs text-muted-foreground'>
                {tr('discoveryHint')}
            </p>
            <IndexError error={action.error} />
            {models && (
                <div className='max-h-48 space-y-2 overflow-auto rounded-lg border p-3'>
                    {models.length === 0 ? (
                        <p>{tr('noModels')}</p>
                    ) : (
                        models.map((model) => (
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
