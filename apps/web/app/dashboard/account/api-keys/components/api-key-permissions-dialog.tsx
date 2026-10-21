'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    validatePermissions,
    type PermissionSet,
} from '@repo/auth/permissions';
import {
    getSelectablePermissions,
    PermissionGrid,
} from '@/components/permissions/permission-grid';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { useORPC } from '@/hooks/use-orpc';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import { Button } from '@repo/ui/button';
import { CollectionScopeEditor } from './collection-scope-editor';
import type { ListedApiKey } from './api-key-line';

/** Creates limited keys or explicitly replaces a legacy key's full-access grant. */
export function ApiKeyPermissionsDialog({
    existing,
    onClose,
    onCreated,
}: {
    readonly existing?: ListedApiKey;
    readonly onClose: () => void;
    readonly onCreated?: (key: string) => void;
}) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const { access, refresh } = useVectorixPermissions();
    const t = useTranslations('permissions');
    const tKeys = useTranslations('apiKeys');
    const [name, setName] = useState('');
    const [permissions, setPermissions] = useState<PermissionSet>(
        existing?.legacyFullAccess ? {} : (existing?.permissions ?? {})
    );
    const [saving, setSaving] = useState(false);
    const [collectionScopes, setCollectionScopes] = useState(
        existing?.collectionScopes ?? []
    );
    const canEditScopes =
        !existing ||
        Boolean(
            existing.issuerMemberId &&
            existing.issuerMemberId === access?.memberId
        );
    const [saveError, setSaveError] = useState<string | null>(null);
    const selectablePermissions = getSelectablePermissions(
        access?.permissions ?? {},
        true
    );
    const allSelectablePermissionsSelected =
        Object.keys(selectablePermissions).length > 0 &&
        Object.entries(selectablePermissions).every(([resource, actions]) =>
            actions.every((action) => permissions[resource]?.includes(action))
        );
    let fullSelectionIsAllowed = true;
    try {
        validatePermissions(selectablePermissions, true);
    } catch {
        fullSelectionIsAllowed = false;
    }
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !saving) onClose();
            }}
        >
            <DialogContent
                className='sm:max-w-4xl'
                closeLabel={tr('common.close')}
            >
                <DialogHeader>
                    <DialogTitle>{t('keyPermissions')}</DialogTitle>
                    <DialogDescription>
                        {existing?.legacyFullAccess
                            ? t('restrictKeyDescription')
                            : t('newKeyDescription')}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className='space-y-4'
                    onSubmit={async (event) => {
                        event.preventDefault();
                        try {
                            validatePermissions(permissions, true);
                        } catch {
                            toast.error(t('explicitKeyRequired'));
                            return;
                        }
                        setSaving(true);
                        setSaveError(null);
                        try {
                            if (existing)
                                await client.admin.organization.apiKeys.updatePermissions(
                                    {
                                        keyId: existing.id,
                                        permissions,
                                        ...(canEditScopes
                                            ? { collectionScopes }
                                            : {}),
                                    }
                                );
                            else {
                                const key =
                                    await client.admin.organization.apiKeys.create(
                                        { name, permissions, collectionScopes }
                                    );
                                onCreated?.(key.key);
                            }
                            await refresh();
                            onClose();
                        } catch (error) {
                            setSaveError(
                                error instanceof Error
                                    ? error.message
                                    : t('failed')
                            );
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
                    {!existing && (
                        <div className='space-y-2'>
                            <Label htmlFor='api-key-name'>
                                {tKeys('name')}
                            </Label>
                            <Input
                                id='api-key-name'
                                required
                                maxLength={64}
                                value={name}
                                onChange={(event) =>
                                    setName(event.target.value)
                                }
                            />
                        </div>
                    )}
                    {!existing && (
                        <div className='flex flex-col items-end gap-2'>
                            <Button
                                type='button'
                                variant='outline'
                                disabled={saving}
                                onClick={() =>
                                    setPermissions(selectablePermissions)
                                }
                            >
                                {t('selectAll')}
                            </Button>
                            {allSelectablePermissionsSelected &&
                                !fullSelectionIsAllowed && (
                                    <p className='text-xs text-amber-600 dark:text-amber-400'>
                                        {t('selectAllLimitedHint')}
                                    </p>
                                )}
                        </div>
                    )}
                    <PermissionGrid
                        value={permissions}
                        onChange={setPermissions}
                        allowed={access?.permissions ?? {}}
                        apiKey
                        readOnly={saving}
                    />
                    {existing && !canEditScopes && (
                        <p className='text-sm text-muted-foreground'>
                            {existing.issuerMemberId
                                ? tr('keys.issuerOnly')
                                : tr('keys.legacyHint')}
                        </p>
                    )}
                    <fieldset disabled={saving}>
                        <CollectionScopeEditor
                            value={collectionScopes}
                            onChange={setCollectionScopes}
                            permissions={permissions}
                            readOnly={!canEditScopes}
                        />
                    </fieldset>
                    {saveError && <p role='alert'>{saveError}</p>}
                    <DialogFooter>
                        <Button
                            type='button'
                            variant='outline'
                            disabled={saving}
                            onClick={onClose}
                        >
                            {t('cancel')}
                        </Button>
                        <Button disabled={saving}>{t('save')}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
