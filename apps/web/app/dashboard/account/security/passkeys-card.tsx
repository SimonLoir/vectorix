'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import {
    securityErrorKey,
    SecurityRequestError,
    type SecurityErrorKey,
} from './security-errors';
import type { SecurityActions } from './security-actions';
import { SecurityConfirmationDialog } from './security-confirmation-dialog';
import { SECURITY_PAGE_SIZE, SecurityPagination } from './security-pagination';

/** Passkey registration stays a native user-triggered WebAuthn ceremony. */
export function PasskeysCard({
    actions,
    userId,
    sessionId,
}: Readonly<{ actions: SecurityActions; userId: string; sessionId: string }>) {
    const auth = useAuth();
    const t = useTranslations('accountSecurity');
    const [name, setName] = useState('');
    const [page, setPage] = useState(0);
    const [error, setError] = useState<SecurityErrorKey | null>(null);
    const [selected, setSelected] = useState<{
        id: string;
        label: string;
    } | null>(null);
    const [deleteError, setDeleteError] = useState<SecurityErrorKey | null>(
        null
    );
    const trigger = useRef<HTMLButtonElement | null>(null);
    const addButton = useRef<HTMLButtonElement | null>(null);
    const passkeys = useQuery({
        queryKey: ['account-passkeys', userId, sessionId],
        queryFn: async () => {
            const result = await auth.passkey.listUserPasskeys();
            if (result.error)
                throw new SecurityRequestError(securityErrorKey(result.error));
            return result.data ?? [];
        },
        retry: false,
    });
    const rows = passkeys.data ?? [];
    const pages = Math.max(1, Math.ceil(rows.length / SECURITY_PAGE_SIZE));
    const currentPage = Math.min(page, pages - 1);

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('passkeys.title')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-6'>
                <p className='text-muted-foreground text-sm'>
                    {t('passkeys.description')}
                </p>
                {passkeys.isPending ? (
                    <p role='status'>{t('passkeys.loading')}</p>
                ) : passkeys.isError ? (
                    <div className='space-y-3'>
                        <p role='alert' className='text-destructive text-sm'>
                            {t('passkeys.loadError')}
                        </p>
                        <Button
                            type='button'
                            variant='outline'
                            disabled={actions.busy || passkeys.isFetching}
                            onClick={() => {
                                void passkeys.refetch();
                            }}
                        >
                            {t('reload')}
                        </Button>
                    </div>
                ) : rows.length === 0 ? (
                    <p>{t('passkeys.empty')}</p>
                ) : (
                    <>
                        <ul className='space-y-3'>
                            {rows
                                .slice(
                                    currentPage * SECURITY_PAGE_SIZE,
                                    (currentPage + 1) * SECURITY_PAGE_SIZE
                                )
                                .map((key) => {
                                    const label = key.name?.trim()
                                        ? key.name
                                        : t('passkeys.fallbackName');
                                    return (
                                        <li
                                            key={key.id}
                                            className='flex items-center justify-between gap-4'
                                        >
                                            <span className='min-w-0 break-words text-sm'>
                                                {label}
                                            </span>
                                            <Button
                                                type='button'
                                                variant='outline'
                                                disabled={actions.busy}
                                                aria-label={t(
                                                    'passkeys.removeLabel',
                                                    { name: label }
                                                )}
                                                onClick={(event) => {
                                                    trigger.current =
                                                        event.currentTarget;
                                                    setDeleteError(null);
                                                    setSelected({
                                                        id: key.id,
                                                        label,
                                                    });
                                                }}
                                            >
                                                {t('passkeys.remove')}
                                            </Button>
                                        </li>
                                    );
                                })}
                        </ul>
                        <SecurityPagination
                            page={currentPage}
                            pages={pages}
                            onPage={setPage}
                            disabled={actions.busy}
                        />
                    </>
                )}
                <form
                    className='space-y-4 border-t pt-4'
                    onSubmit={async (event) => {
                        event.preventDefault();
                        setError(null);
                        const result = await actions.perform(() =>
                            auth.passkey.addPasskey({
                                name: name.trim() || t('passkeys.defaultName'),
                            })
                        );
                        if (!result.success) {
                            setError(result.error);
                            return;
                        }
                        setName('');
                        toast.success(t('passkeys.added'));
                        await passkeys.refetch();
                    }}
                >
                    <label className='block space-y-2'>
                        <span>{t('passkeys.name')}</span>
                        <Input
                            name='passkeyName'
                            value={name}
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                            maxLength={64}
                            autoComplete='off'
                            placeholder={t('passkeys.namePlaceholder')}
                            disabled={actions.busy}
                        />
                    </label>
                    <p className='text-muted-foreground text-sm'>
                        {t('passkeys.addHelp')}
                    </p>
                    {error && (
                        <p role='alert' className='text-destructive text-sm'>
                            {t(`errors.${error}`)}
                        </p>
                    )}
                    <Button
                        ref={addButton}
                        type='submit'
                        disabled={actions.busy}
                    >
                        {actions.busy ? t('working') : t('passkeys.add')}
                    </Button>
                </form>
                <SecurityConfirmationDialog
                    open={selected !== null}
                    onOpenChange={(open) => {
                        if (!open) {
                            setSelected(null);
                            setDeleteError(null);
                        }
                    }}
                    title={t('passkeys.removeTitle')}
                    description={t('passkeys.removeDescription', {
                        name: selected?.label ?? '',
                    })}
                    confirmLabel={t('passkeys.remove')}
                    busy={actions.busy}
                    error={deleteError}
                    returnFocus={() => {
                        (trigger.current?.isConnected
                            ? trigger.current
                            : addButton.current
                        )?.focus();
                    }}
                    onConfirm={async () => {
                        if (!selected) return;
                        setDeleteError(null);
                        const result = await actions.perform(() =>
                            auth.passkey.deletePasskey({ id: selected.id })
                        );
                        if (!result.success) {
                            setDeleteError(result.error);
                            return;
                        }
                        setSelected(null);
                        toast.success(t('passkeys.removed'));
                        await passkeys.refetch();
                    }}
                />
            </CardContent>
        </Card>
    );
}
