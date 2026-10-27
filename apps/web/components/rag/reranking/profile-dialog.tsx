'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import Link from 'next/link';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { RERANKING_LIMITS } from '@repo/reranking/models';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { CheckField, TextField } from '../form-fields';
import {
    ProfileModelFields,
    defaultRerankingModel,
} from './profile-model-fields';
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
        profile.configuration?.model ?? defaultRerankingModel('COHERE')
    );
    const [candidatePool, setCandidatePool] = useState(
        String(
            profile.configuration?.candidatePool ??
                (provider === 'TEI' ? 32 : 50)
        )
    );
    const tei = provider === 'TEI';
    const [enabled, setEnabled] = useState(profile.enabled);
    const metadataSave = tei && enabled;
    const saveLabel = metadataSave ? tr('selfHosted.save') : common('save');
    const busyLabel = metadataSave
        ? tr('selfHosted.reading')
        : common('saving');
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
                    void action.run(
                        () =>
                            client.admin.rag.reranking.extended.configure({
                                collectionId,
                                expectedRevision,
                                enabled,
                                provider,
                                model,
                                candidatePool: Number(candidatePool),
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
                    <ProfileModelFields
                        provider={provider}
                        model={model}
                        onModelChange={setModel}
                        onProviderChange={(value) => {
                            setProvider(value);
                            setModel(defaultRerankingModel(value));
                            setCandidatePool(String(value === 'TEI' ? 32 : 50));
                        }}
                    />
                    <TextField
                        label={tr('candidatePool')}
                        name='candidatePool'
                        type='number'
                        required
                        min={1}
                        max={RERANKING_LIMITS.documents}
                        value={candidatePool}
                        onChange={(event) =>
                            setCandidatePool(event.target.value)
                        }
                    />
                    <p className='text-xs text-muted-foreground'>
                        {tr('candidateHint')}
                    </p>
                </fieldset>
                <ProfileSaveNotice
                    tei={tei}
                    enabled={enabled}
                    busy={action.busy}
                />
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
                        {action.busy ? busyLabel : saveLabel}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}

function ProfileSaveNotice({
    tei,
    enabled,
    busy,
}: Readonly<{ tei: boolean; enabled: boolean; busy: boolean }>) {
    const tr = useTranslations('rag.reranking');
    const { canOperation } = useVectorixPermissions();
    return (
        <>
            <p className='rounded-lg border bg-muted/30 p-3 text-sm'>
                {enabled
                    ? tr(tei ? 'selfHosted.enableHint' : 'enableHint')
                    : tr('disabledDraftHint')}
            </p>
            {tei &&
                !busy &&
                canOperation('admin.rag.reranking.endpoints.list') && (
                    <Link
                        href='/dashboard/settings/integrations'
                        className='inline-flex text-sm font-medium text-primary underline underline-offset-4'
                    >
                        {tr('selfHosted.manageEndpoints')}
                    </Link>
                )}
        </>
    );
}
