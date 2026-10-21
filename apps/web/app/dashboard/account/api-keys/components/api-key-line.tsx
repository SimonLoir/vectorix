'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { VectorixApiV1Outputs } from '@repo/api';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { Button } from '@repo/ui/button';
import { TableCell, TableRow } from '@repo/ui/table';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@repo/ui/alert-dialog';
import LocalizedDate from '@/components/localized-date';
import { ApiKeyPermissionsDialog } from './api-key-permissions-dialog';

export type ListedApiKey =
    VectorixApiV1Outputs['admin']['organization']['apiKeys']['list']['keys'][number];

/** Displays a key's legacy status and permits explicit restriction or revocation. */
export default function ApiKeyLine({
    apiKey,
}: {
    readonly apiKey: ListedApiKey;
}) {
    const tr = useTranslations('rag');
    const auth = useAuth();
    const { can, refresh } = useVectorixPermissions();
    const t = useTranslations('permissions');
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [busy, setBusy] = useState(false);
    return (
        <>
            <TableRow>
                <TableCell>{apiKey.name ?? apiKey.id}</TableCell>
                <TableCell>
                    <LocalizedDate value={apiKey.createdAt} timeStyle='short' />
                </TableCell>
                <TableCell>
                    {apiKey.expiresAt ? (
                        <LocalizedDate
                            value={apiKey.expiresAt}
                            timeStyle='short'
                        />
                    ) : (
                        '—'
                    )}
                </TableCell>
                <TableCell>
                    {apiKey.legacyFullAccess ? t('legacyKey') : t('limitedKey')}
                    <p className='mt-1 text-xs text-muted-foreground'>
                        {apiKey.issuerMemberId
                            ? tr('keys.count', {
                                  count: apiKey.collectionScopes.length,
                              })
                            : tr('keys.legacy')}
                    </p>
                </TableCell>
                <TableCell className='flex gap-2'>
                    {can({ apiKey: ['update'] }) && (
                        <Button
                            variant='outline'
                            onClick={() => setEditing(true)}
                        >
                            {t('restrictKey')}
                        </Button>
                    )}
                    {can({ apiKey: ['delete'] }) && (
                        <Button
                            variant='outline'
                            onClick={() => setDeleting(true)}
                        >
                            {t('delete')}
                        </Button>
                    )}
                </TableCell>
            </TableRow>
            {editing && (
                <ApiKeyPermissionsDialog
                    existing={apiKey}
                    onClose={() => setEditing(false)}
                />
            )}
            <AlertDialog
                open={deleting}
                onOpenChange={(open) => {
                    if (!busy) setDeleting(open);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t('delete')}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {apiKey.name ?? apiKey.id}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy}>
                            {t('cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            disabled={busy}
                            onClick={async (event) => {
                                event.preventDefault();
                                setBusy(true);
                                try {
                                    const result = await auth.apiKey.delete({
                                        keyId: apiKey.id,
                                        configId: 'org',
                                    });
                                    if (result.error)
                                        throw new Error(result.error.message);
                                    await refresh();
                                    setDeleting(false);
                                } catch (error) {
                                    toast.error(
                                        error instanceof Error
                                            ? error.message
                                            : t('failed')
                                    );
                                } finally {
                                    setBusy(false);
                                }
                            }}
                        >
                            {t('delete')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
