'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import DashboardPage from '@/components/dashboard-page';
import PageTitle from '@repo/dashboard-core/components/page-title';
import { Button } from '@repo/ui/button';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@repo/ui/table';
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogCancel,
    AlertDialogAction,
} from '@repo/ui/alert-dialog';
import type { PermissionSet } from '@repo/auth/permissions';
import { RoleEditorDialog } from './role-editor-dialog';

type Role = {
    role: string;
    permissions: PermissionSet;
    builtIn: boolean;
    assignable: boolean;
};

/** Lists organization roles and protects built-in compatibility roles from modification. */
export function RolesManager() {
    const { access, can, refresh } = useVectorixPermissions();
    const auth = useAuth();
    const t = useTranslations('permissions');
    const [editor, setEditor] = useState<Role | 'new' | null>(null);
    const [viewing, setViewing] = useState<Role | null>(null);
    const [deleting, setDeleting] = useState<Role | null>(null);
    const [busy, setBusy] = useState(false);
    return (
        <DashboardPage className='space-y-6'>
            <div className='flex flex-wrap items-center justify-between gap-4'>
                <PageTitle>{t('title')}</PageTitle>
                <div className='flex flex-wrap gap-2'>
                    {can({ ac: ['create'] }) && (
                        <Button onClick={() => setEditor('new')}>
                            {t('createRole')}
                        </Button>
                    )}
                </div>
            </div>
            <p className='text-muted-foreground'>{t('description')}</p>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t('roleName')}</TableHead>
                        <TableHead>{t('permissions')}</TableHead>
                        <TableHead>{t('actionsLabel')}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {access?.roles.map((role) => (
                        <TableRow key={role.role}>
                            <TableCell>
                                {role.role}
                                {role.builtIn && (
                                    <span className='ml-2 text-xs text-muted-foreground'>
                                        {t('builtIn')}
                                    </span>
                                )}
                            </TableCell>
                            <TableCell>
                                {Object.values(role.permissions).reduce(
                                    (count, actions) => count + actions.length,
                                    0
                                )}
                            </TableCell>
                            <TableCell className='flex gap-2'>
                                <Button
                                    variant='outline'
                                    onClick={() => setViewing(role)}
                                >
                                    {t('readRole')}
                                </Button>
                                {!role.builtIn &&
                                    role.assignable &&
                                    can({ ac: ['update'] }) && (
                                        <Button
                                            variant='outline'
                                            onClick={() => setEditor(role)}
                                        >
                                            {t('edit')}
                                        </Button>
                                    )}
                                {!role.builtIn &&
                                    role.assignable &&
                                    can({ ac: ['delete'] }) && (
                                        <Button
                                            variant='outline'
                                            onClick={() => setDeleting(role)}
                                        >
                                            {t('delete')}
                                        </Button>
                                    )}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
            {editor && (
                <RoleEditorDialog
                    existing={editor === 'new' ? undefined : editor}
                    onClose={() => setEditor(null)}
                />
            )}
            {viewing && (
                <RoleEditorDialog
                    existing={viewing}
                    readOnly
                    onClose={() => setViewing(null)}
                />
            )}
            <AlertDialog
                open={Boolean(deleting)}
                onOpenChange={(open) => {
                    if (!open && !busy) setDeleting(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t('deleteRole')}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('deleteRoleDescription', {
                                role: deleting?.role ?? '',
                            })}
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
                                if (!deleting) return;
                                setBusy(true);
                                try {
                                    const result =
                                        await auth.organization.deleteRole({
                                            roleName: deleting.role,
                                        });
                                    if (result.error)
                                        throw new Error(result.error.message);
                                    await refresh();
                                    setDeleting(null);
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
        </DashboardPage>
    );
}
