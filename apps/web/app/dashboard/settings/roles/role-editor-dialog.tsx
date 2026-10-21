'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { PermissionGrid } from '@/components/permissions/permission-grid';
import type { PermissionSet } from '@repo/auth/permissions';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@repo/ui/dialog';

/** Edits permissions through Better Auth; role identifiers stay stable for existing memberships. */
export function RoleEditorDialog({
    existing,
    onClose,
    readOnly = false,
}: {
    readonly existing?: { role: string; permissions: PermissionSet };
    readonly onClose: () => void;
    readonly readOnly?: boolean;
}) {
    const t = useTranslations('permissions');
    const auth = useAuth();
    const { access, refresh } = useVectorixPermissions();
    const [name, setName] = useState(existing?.role ?? '');
    const [permissions, setPermissions] = useState<PermissionSet>(
        existing?.permissions ?? {}
    );
    const [saving, setSaving] = useState(false);
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !saving) onClose();
            }}
        >
            <DialogContent className='sm:max-w-4xl'>
                <DialogHeader>
                    <DialogTitle>
                        {readOnly
                            ? t('readRole')
                            : existing
                              ? t('editRole')
                              : t('createRole')}
                    </DialogTitle>
                    <DialogDescription>
                        {t('editorDescription')}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className='space-y-4'
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (readOnly) return;
                        setSaving(true);
                        try {
                            const result = existing
                                ? await auth.organization.updateRole({
                                      roleName: existing.role,
                                      data: { permission: permissions },
                                  })
                                : await auth.organization.createRole({
                                      role: name,
                                      permission: permissions,
                                  });
                            if (result.error)
                                throw new Error(result.error.message);
                            await refresh();
                            toast.success(t('saved'));
                            onClose();
                        } catch (error) {
                            toast.error(
                                error instanceof Error
                                    ? error.message
                                    : t('failed')
                            );
                        } finally {
                            setSaving(false);
                        }
                    }}
                >
                    <div className='space-y-2'>
                        <Label htmlFor='role-name'>{t('roleName')}</Label>
                        <Input
                            id='role-name'
                            value={name}
                            disabled={Boolean(existing) || saving}
                            required
                            pattern={String.raw`[a-z][a-z0-9_\-]{1,63}`}
                            onChange={(event) => setName(event.target.value)}
                            placeholder='reception'
                        />
                    </div>
                    <PermissionGrid
                        value={permissions}
                        onChange={setPermissions}
                        allowed={access?.permissions ?? {}}
                        readOnly={saving || readOnly}
                    />
                    <DialogFooter>
                        <Button
                            type='button'
                            variant='outline'
                            disabled={saving}
                            onClick={onClose}
                        >
                            {t('cancel')}
                        </Button>
                        {!readOnly && (
                            <Button disabled={saving}>{t('save')}</Button>
                        )}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
