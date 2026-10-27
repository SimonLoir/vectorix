'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { RerankEndpointFields } from './endpoint-fields';
import type { RerankEndpoint } from './types';

/** Blank edits preserve the encrypted key; removal and destination changes are explicit. */
export function RerankEndpointForm({
    existing,
    onClose,
}: Readonly<{ existing?: RerankEndpoint; onClose: () => void }>) {
    const tr = useTranslations('rag.reranking.endpoints');
    const rag = useTranslations('rag');
    const { client } = useORPC();
    const mutation = useCatalogAction();
    const [expectedRevision] = useState(existing?.revision ?? 0);
    const [secretRequired, setSecretRequired] = useState(false);
    return (
        <CatalogDialog
            title={tr(existing ? 'edit' : 'create')}
            description={tr('formDescription')}
            busy={mutation.busy}
            onClose={onClose}
        >
            <form
                className='space-y-4'
                onChange={(event) => {
                    if (!existing) return;
                    const data = new FormData(event.currentTarget);
                    setSecretRequired(
                        String(data.get('endpoint') ?? '') !==
                            existing.endpoint &&
                            existing.apiKey !== null &&
                            !data.has('removeKey')
                    );
                }}
                onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    const name = String(data.get('name'));
                    const endpoint = String(data.get('endpoint'));
                    const enteredKey = String(data.get('apiKey') ?? '');
                    void mutation.run(
                        () =>
                            existing
                                ? client.admin.rag.reranking.endpoints.update({
                                      id: existing.id,
                                      expectedRevision,
                                      name,
                                      endpoint,
                                      apiKey: data.has('removeKey')
                                          ? null
                                          : enteredKey || undefined,
                                  })
                                : client.admin.rag.reranking.endpoints.create({
                                      name,
                                      endpoint,
                                      provider: 'TEI',
                                      apiKey: enteredKey || null,
                                      activate: data.has('activate'),
                                  }),
                        onClose
                    );
                }}
            >
                <RerankEndpointFields
                    existing={existing}
                    busy={mutation.busy}
                    secretRequired={secretRequired}
                />
                <ActionError error={mutation.error} />
                <div className='flex flex-wrap justify-end gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={mutation.busy}
                        onClick={onClose}
                    >
                        {rag('common.cancel')}
                    </Button>
                    <Button type='submit' disabled={mutation.busy}>
                        {rag(mutation.busy ? 'common.saving' : 'common.save')}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
