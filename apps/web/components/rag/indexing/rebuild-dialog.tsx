'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { ProfileSummary } from '../collections/profile-summary';
import { IndexError, useIndexAction } from './index-state';
import type { Collection } from '../types';
import type { IndexStatus } from './types';

export type RebuildReview = {
    collectionId: string;
    revision: number;
    activeGenerationId: string;
    activeRevision: number;
    activeConfiguration: Collection['configuration'];
    draftConfiguration: Collection['configuration'];
};

/** Keep the reviewed revision and predecessor stable even if background polling changes the active pointer. */
export function RebuildDialog({
    review,
    blockedReason,
    onClose,
}: Readonly<{
    review: RebuildReview;
    blockedReason: IndexStatus['rebuildBlockedReason'];
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const action = useIndexAction();
    const [requestId] = useState(() => crypto.randomUUID());
    const identical = Object.entries(review.draftConfiguration).every(
        ([key, value]) =>
            JSON.stringify(value) ===
            JSON.stringify(
                review.activeConfiguration[
                    key as keyof Collection['configuration']
                ]
            )
    );
    return (
        <CatalogDialog
            title={tr('indexing.rebuild.title')}
            description={tr('indexing.rebuild.description', {
                active: review.activeRevision,
                draft: review.revision,
            })}
            busy={action.busy}
            onClose={onClose}
        >
            <p className='rounded-lg bg-muted p-4 text-sm'>
                {tr('indexing.rebuild.availability')}
            </p>
            {identical && (
                <p className='text-sm text-muted-foreground'>
                    {tr('indexing.rebuild.sameProfile')}
                </p>
            )}
            <div className='grid gap-5'>
                <section className='space-y-4 rounded-lg border p-4'>
                    <h3 className='font-semibold'>
                        {tr('indexing.rebuild.activeProfile', {
                            revision: review.activeRevision,
                        })}
                    </h3>
                    <ProfileSummary
                        configuration={review.activeConfiguration}
                    />
                </section>
                <section className='space-y-4 rounded-lg border p-4'>
                    <h3 className='font-semibold'>
                        {tr('indexing.rebuild.draftProfile', {
                            revision: review.revision,
                        })}
                    </h3>
                    <ProfileSummary configuration={review.draftConfiguration} />
                </section>
            </div>
            <p className='text-sm'>{tr('indexing.rebuild.requirements')}</p>
            {blockedReason && (
                <p role='alert'>{tr(`indexing.errors.${blockedReason}`)}</p>
            )}
            <IndexError error={action.error} />
            <div className='flex flex-wrap justify-end gap-2'>
                <Button
                    variant='outline'
                    disabled={action.busy}
                    onClick={onClose}
                >
                    {tr('common.cancel')}
                </Button>
                <Button
                    disabled={action.busy || Boolean(blockedReason)}
                    onClick={() =>
                        void action.run(
                            () =>
                                client.admin.rag.indexing.rebuild({
                                    collectionId: review.collectionId,
                                    expectedRevision: review.revision,
                                    expectedActiveGenerationId:
                                        review.activeGenerationId,
                                    requestId,
                                }),
                            onClose
                        )
                    }
                >
                    {action.busy
                        ? tr('indexing.working')
                        : tr('indexing.rebuild.confirm')}
                </Button>
            </div>
        </CatalogDialog>
    );
}
