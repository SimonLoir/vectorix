'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import {
    securityErrorKey,
    SecurityRequestError,
    type SecurityErrorKey,
} from './security-errors';
import type { SecurityActions } from './security-actions';
import { SecurityConfirmationDialog } from './security-confirmation-dialog';
import { SECURITY_PAGE_SIZE, SecurityPagination } from './security-pagination';

/** Session tokens remain in the native revoke request and are never rendered or logged. */
export function SessionsCard({
    actions,
    userId,
    sessionId,
}: Readonly<{ actions: SecurityActions; userId: string; sessionId: string }>) {
    const auth = useAuth();
    const t = useTranslations('accountSecurity');
    const format = useFormatter();
    const [page, setPage] = useState(0);
    const [selected, setSelected] = useState<{
        token: string;
        label: string;
    } | null>(null);
    const [error, setError] = useState<SecurityErrorKey | null>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const reloadButton = useRef<HTMLButtonElement | null>(null);
    const sessions = useQuery({
        queryKey: ['account-sessions', userId, sessionId],
        queryFn: async () => {
            const result = await auth.listSessions();
            if (result.error)
                throw new SecurityRequestError(securityErrorKey(result.error));
            return result.data ?? [];
        },
        retry: false,
    });
    const rows = sessions.data ?? [];
    const pages = Math.max(1, Math.ceil(rows.length / SECURITY_PAGE_SIZE));
    const currentPage = Math.min(page, pages - 1);

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('sessions.title')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-4'>
                <p className='text-muted-foreground text-sm'>
                    {t('sessions.description')}
                </p>
                {sessions.isPending ? (
                    <p role='status'>{t('sessions.loading')}</p>
                ) : sessions.isError ? (
                    <p role='alert' className='text-destructive text-sm'>
                        {t('sessions.loadError')}
                    </p>
                ) : rows.length === 0 ? (
                    <p>{t('sessions.empty')}</p>
                ) : (
                    <>
                        <ul className='space-y-3'>
                            {rows
                                .slice(
                                    currentPage * SECURITY_PAGE_SIZE,
                                    (currentPage + 1) * SECURITY_PAGE_SIZE
                                )
                                .map((item) => {
                                    const device = item.userAgent?.slice(
                                        0,
                                        200
                                    );
                                    const label = device?.trim()
                                        ? device
                                        : t('sessions.unknownDevice');
                                    const current = item.id === sessionId;
                                    return (
                                        <li
                                            key={item.id}
                                            className='flex flex-wrap items-center justify-between gap-4'
                                        >
                                            <div className='min-w-0 flex-1 space-y-1'>
                                                <p className='break-words text-sm'>
                                                    {label}
                                                </p>
                                                {current && (
                                                    <p className='font-medium text-sm'>
                                                        {t('sessions.current')}
                                                    </p>
                                                )}
                                                <p className='text-muted-foreground text-sm'>
                                                    {t('sessions.created', {
                                                        date: format.dateTime(
                                                            item.createdAt,
                                                            {
                                                                dateStyle:
                                                                    'medium',
                                                                timeStyle:
                                                                    'short',
                                                            }
                                                        ),
                                                    })}
                                                </p>
                                            </div>
                                            {!current && (
                                                <Button
                                                    type='button'
                                                    variant='outline'
                                                    disabled={actions.busy}
                                                    aria-label={t(
                                                        'sessions.revokeLabel',
                                                        { device: label }
                                                    )}
                                                    onClick={(event) => {
                                                        trigger.current =
                                                            event.currentTarget;
                                                        setError(null);
                                                        setSelected({
                                                            token: item.token,
                                                            label,
                                                        });
                                                    }}
                                                >
                                                    {t('sessions.revoke')}
                                                </Button>
                                            )}
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
                <Button
                    ref={reloadButton}
                    type='button'
                    variant='outline'
                    disabled={actions.busy || sessions.isFetching}
                    onClick={() => {
                        void sessions.refetch();
                    }}
                >
                    {sessions.isFetching
                        ? t('sessions.refreshing')
                        : t('reload')}
                </Button>
                <SecurityConfirmationDialog
                    open={selected !== null}
                    onOpenChange={(open) => {
                        if (!open) {
                            setSelected(null);
                            setError(null);
                        }
                    }}
                    title={t('sessions.revokeTitle')}
                    description={t('sessions.revokeDescription', {
                        device: selected?.label ?? '',
                    })}
                    confirmLabel={t('sessions.revoke')}
                    busy={actions.busy}
                    error={error}
                    returnFocus={() => {
                        (trigger.current?.isConnected
                            ? trigger.current
                            : reloadButton.current
                        )?.focus();
                    }}
                    onConfirm={async () => {
                        if (!selected) return;
                        setError(null);
                        const result = await actions.perform(() =>
                            auth.revokeSession({ token: selected.token })
                        );
                        if (!result.success) {
                            setError(result.error);
                            return;
                        }
                        setSelected(null);
                        toast.success(t('sessions.revoked'));
                        await sessions.refetch();
                    }}
                />
            </CardContent>
        </Card>
    );
}
