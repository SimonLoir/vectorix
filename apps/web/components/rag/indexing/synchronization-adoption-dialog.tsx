'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { IndexError } from './index-state';

/** The opened dialog retains its exact generation/CAS token; adoption is never automatically retried. */
export function SynchronizationAdoptionDialog({
    collectionId,
    generationId,
    expectedAuthorityUserId,
    currentAuthorityUserId,
    canAdopt,
    pendingRebuild,
    onClose,
}: Readonly<{
    collectionId: string;
    generationId: string;
    expectedAuthorityUserId: string | null;
    currentAuthorityUserId: string | null | undefined;
    canAdopt: boolean;
    pendingRebuild: boolean;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag.indexing.synchronization');
    const { client } = useORPC();
    const cache = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [result, setResult] = useState<{
        reboundPendingTasks: number;
        interruptedTasks: number;
    } | null>(null);
    const stale =
        !canAdopt || currentAuthorityUserId !== expectedAuthorityUserId;
    async function adopt() {
        if (stale || busy || failed || result) return;
        setBusy(true);
        try {
            const response =
                await client.admin.rag.indexing.adoptSynchronization({
                    collectionId,
                    generationId,
                    expectedAuthorityUserId,
                });
            setResult(response);
            await cache.invalidateQueries();
        } catch {
            // A timeout can follow a committed adoption: require refresh/review, never replay blindly.
            setFailed(true);
            await cache.invalidateQueries();
        } finally {
            setBusy(false);
        }
    }
    return (
        <CatalogDialog
            title={tr('dialogTitle')}
            description={tr('dialogDescription')}
            busy={busy}
            onClose={onClose}
        >
            <div className='space-y-3 text-sm'>
                <p className='break-all'>
                    {tr('generation', { id: generationId })}
                </p>
                <p>{tr('pendingWork')}</p>
                <p>{tr('failedUnchanged')}</p>
                {pendingRebuild && <p>{tr('rebuildRights')}</p>}
                <p>{tr('profileUnchanged')}</p>
                {!result && stale && <p role='status'>{tr('stale')}</p>}
                <IndexError error={failed ? tr('failed') : null} />
                {result && (
                    <p role='status'>
                        {tr('success', {
                            pending: result.reboundPendingTasks,
                            interrupted: result.interruptedTasks,
                        })}
                    </p>
                )}
                <div className='flex flex-wrap justify-end gap-2'>
                    <Button variant='outline' disabled={busy} onClick={onClose}>
                        {result || failed || stale ? tr('close') : tr('cancel')}
                    </Button>
                    {!result && !failed && (
                        <Button
                            disabled={busy || stale}
                            onClick={() => void adopt()}
                        >
                            {busy ? tr('working') : tr('confirm')}
                        </Button>
                    )}
                </div>
            </div>
        </CatalogDialog>
    );
}
