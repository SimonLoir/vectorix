'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { listRerankingModels, RERANKING_LIMITS } from '@repo/reranking/models';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { CheckField, SelectField, TextField } from '../form-fields';
import { IndexError } from '../indexing/index-state';
import { useRerankAction } from './rerank-action';
import type { RerankProfile, RerankProvider } from './types';

/** The saved revision is captured once; concurrent edits are rejected by server-side CAS. */
export function RerankProfileDialog({
    collectionId,
    profile,
    onClose,
}: Readonly<{
    collectionId: string;
    profile: RerankProfile;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag.reranking');
    const common = useTranslations('rag.common');
    const { client } = useORPC();
    const action = useRerankAction();
    const [expectedRevision] = useState(profile.revision);
    const [provider, setProvider] = useState<RerankProvider>(
        profile.configuration?.provider ?? 'COHERE'
    );
    const [model, setModel] = useState(
        profile.configuration?.model ?? listRerankingModels('COHERE')[0]!.id
    );
    const models = listRerankingModels(provider);
    const [enabled, setEnabled] = useState(profile.enabled);
    return (
        <CatalogDialog
            title={tr('configure')}
            description={tr('configureHint')}
            busy={action.busy}
            onClose={onClose}
        >
            <form
                className='space-y-4'
                onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    void action.run(
                        () =>
                            client.admin.rag.reranking.configure({
                                collectionId,
                                expectedRevision,
                                enabled,
                                provider,
                                model,
                                candidatePool: Number(
                                    data.get('candidatePool')
                                ),
                            }),
                        onClose,
                        true
                    );
                }}
            >
                <fieldset disabled={action.busy} className='space-y-4'>
                    <CheckField
                        label={tr('allow')}
                        checked={enabled}
                        onChange={(event) => setEnabled(event.target.checked)}
                    />
                    <div className='grid gap-4 sm:grid-cols-2'>
                        <SelectField
                            label={tr('provider')}
                            value={provider}
                            onChange={(event) => {
                                const value = event.target.value;
                                if (value === 'COHERE' || value === 'VOYAGE') {
                                    setProvider(value);
                                    setModel(listRerankingModels(value)[0]!.id);
                                }
                            }}
                        >
                            <option value='COHERE'>Cohere</option>
                            <option value='VOYAGE'>Voyage</option>
                        </SelectField>
                        <SelectField
                            label={tr('model')}
                            value={model}
                            onChange={(event) => setModel(event.target.value)}
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
                    </div>
                    <TextField
                        label={tr('candidatePool')}
                        name='candidatePool'
                        type='number'
                        required
                        min={1}
                        max={RERANKING_LIMITS.documents}
                        defaultValue={
                            profile.configuration?.candidatePool ?? 50
                        }
                    />
                    <p className='text-xs text-muted-foreground'>
                        {tr('candidateHint')}
                    </p>
                    <p className='rounded-lg border bg-muted/30 p-3 text-sm'>
                        {enabled ? tr('enableHint') : tr('disabledDraftHint')}
                    </p>
                </fieldset>
                <IndexError error={action.error} />
                <div className='flex flex-wrap justify-end gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={action.busy}
                        onClick={onClose}
                    >
                        {common('cancel')}
                    </Button>
                    <Button type='submit' disabled={action.busy}>
                        {action.busy ? common('saving') : common('save')}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
