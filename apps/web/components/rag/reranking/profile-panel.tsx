'use client';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowDownWideNarrow, Settings2 } from 'lucide-react';
import { Button } from '@repo/ui/button';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { useRerankProfile } from './use-rerank-profile';
import { RerankProfileDialog } from './profile-dialog';

/** Reranking is configured independently of embeddings and does not require an index rebuild. */
export function RerankProfilePanel({
    collectionId,
}: Readonly<{ collectionId: string }>) {
    const tr = useTranslations('rag.reranking');
    const common = useTranslations('rag.common');
    const format = useFormatter();
    const { canOperation } = useVectorixPermissions();
    const { query, profile, allowed } = useRerankProfile(collectionId);
    const [editing, setEditing] = useState(false);
    if (!allowed) return null;
    const canManage =
        profile?.canManage && canOperation('admin.rag.reranking.configure');
    return (
        <section className='space-y-4 rounded-xl border bg-card p-5'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0 space-y-1'>
                    <h3 className='flex items-center gap-2 font-semibold'>
                        <ArrowDownWideNarrow
                            className='size-4 text-primary'
                            aria-hidden
                        />
                        {tr('title')}
                    </h3>
                    <p className='max-w-2xl text-sm text-muted-foreground'>
                        {tr('description')}
                    </p>
                </div>
                {canManage && (
                    <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => setEditing(true)}
                    >
                        <Settings2 className='size-4' aria-hidden />
                        {tr('configure')}
                    </Button>
                )}
            </div>
            {query.isError ? (
                <div role='alert' className='space-y-2'>
                    <p className='text-sm'>{tr('loadFailed')}</p>
                    <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        onClick={() => void query.refetch()}
                    >
                        {common('retry')}
                    </Button>
                </div>
            ) : profile ? (
                <div className='space-y-3'>
                    <p className='text-sm font-medium'>
                        {profile.enabled ? tr('enabled') : tr('disabled')}
                    </p>
                    {profile.configuration && (
                        <p className='break-words text-sm text-muted-foreground'>
                            {tr('profileSummary', {
                                provider: profile.configuration.provider,
                                model: profile.configuration.model,
                                count: profile.configuration.candidatePool,
                                revision: format.number(profile.revision),
                            })}
                        </p>
                    )}
                    {profile.configuration && (
                        <p className='text-xs text-muted-foreground'>
                            {tr(
                                `bindings.${profile.configuration.bindingSource}`
                            )}
                        </p>
                    )}
                    <p className='text-xs text-muted-foreground'>
                        {tr('optInHint')}
                    </p>
                </div>
            ) : (
                <p role='status' className='text-sm'>
                    {common('loading')}
                </p>
            )}
            {editing && profile && canManage && (
                <RerankProfileDialog
                    collectionId={collectionId}
                    profile={profile}
                    onClose={() => setEditing(false)}
                />
            )}
        </section>
    );
}
