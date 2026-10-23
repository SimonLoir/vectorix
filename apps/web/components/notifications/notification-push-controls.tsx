'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BellIcon, BellOffIcon, RefreshCcwIcon } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useTranslations } from 'next-intl';
import { useORPC } from '@/hooks/use-orpc';
import {
    clearNotificationPushReceipt,
    currentNotificationPushSubscription,
    notificationPushDeviceId,
    notificationPushRegistrationInput,
    notificationPushSupport,
    readNotificationPushReceipt,
    subscribeToNotifications,
    unsubscribeFromNotifications,
    writeNotificationPushReceipt,
    type NotificationPushReceipt,
} from '@/lib/notification-push';
import {
    createNotificationPushActionGate,
    disableNotificationPush,
    enableNotificationPush,
    type DisablePushOutcome,
    type EnablePushOutcome,
} from '@/lib/notification-push-actions';

type PushConfig = Readonly<{ enabled: boolean; publicKey: string | null }>;
type Feedback = DisablePushOutcome['status'] | EnablePushOutcome['status'];

async function loadPushConfig(signal: AbortSignal): Promise<PushConfig> {
    const response = await fetch('/api/notification-push-config', { signal });
    if (!response.ok) throw new Error('PUSH_CONFIG_UNAVAILABLE');
    const value: unknown = await response.json();
    if (
        typeof value !== 'object' ||
        value === null ||
        !('enabled' in value) ||
        typeof value.enabled !== 'boolean' ||
        !('publicKey' in value) ||
        (value.publicKey !== null && typeof value.publicKey !== 'string')
    )
        throw new Error('PUSH_CONFIG_INVALID');
    return { enabled: value.enabled, publicKey: value.publicKey };
}

function browserPermission() {
    return typeof Notification === 'undefined' ? null : Notification.permission;
}

function useBrowserPushState(userId: string, organizationId: string) {
    const [receipt, setReceipt] = useState<NotificationPushReceipt | null>(
        null
    );
    const [local, setLocal] = useState(false);
    const [checking, setChecking] = useState(true);
    const [checkFailed, setCheckFailed] = useState(false);
    const [permission, setPermission] = useState<NotificationPermission | null>(
        null
    );
    const supported = notificationPushSupport().supported;

    const refresh = useCallback(async () => {
        setChecking(true);
        const saved = readNotificationPushReceipt(userId, organizationId);
        setReceipt((previous) =>
            previous?.serverRevoked &&
            saved !== null &&
            previous.id === saved.id &&
            previous.version === saved.version
                ? previous
                : saved
        );
        setPermission(browserPermission());
        try {
            setLocal(Boolean(await currentNotificationPushSubscription()));
            setCheckFailed(false);
        } catch {
            setCheckFailed(true);
        } finally {
            setChecking(false);
        }
    }, [organizationId, userId]);

    useEffect(() => {
        let active = true;
        globalThis.queueMicrotask(() => {
            if (active) void refresh();
        });
        return () => {
            active = false;
        };
    }, [refresh, supported]);
    return {
        receipt,
        setReceipt,
        local,
        setLocal,
        checking,
        checkFailed,
        permission,
        setPermission,
        supported,
        refresh,
    };
}

/** Explicit browser consent and scoped server cleanup remain independent actions. */
export function NotificationPushControls({
    organizationId,
    userId,
}: Readonly<{
    organizationId: string;
    userId: string;
}>) {
    const t = useTranslations('notifications.preferences.push');
    const { orpc } = useORPC();
    const gate = useRef(createNotificationPushActionGate());
    const [pending, setPending] = useState(false);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [serverRevoked, setServerRevoked] = useState(false);
    const [cleanupNeeded, setCleanupNeeded] = useState(false);
    const browser = useBrowserPushState(userId, organizationId);
    const config = useQuery({
        queryKey: ['notification-push-config'],
        queryFn: ({ signal }) => loadPushConfig(signal),
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
    });
    const register = useMutation(
        orpc.admin.notifications.pushSubscriptions.register.mutationOptions({})
    );
    const revoke = useMutation(
        orpc.admin.notifications.pushSubscriptions.revoke.mutationOptions({})
    );
    const cleanupAvailable =
        Boolean(browser.receipt) ||
        browser.local ||
        cleanupNeeded ||
        browser.checkFailed;
    const ready =
        browser.supported &&
        config.data?.enabled &&
        Boolean(config.data.publicKey) &&
        browser.permission !== 'denied';

    const run = (action: () => Promise<void>) => {
        void gate.current.run(async () => {
            setPending(true);
            try {
                await action();
            } catch {
                setFeedback('enableFailed');
            } finally {
                setPending(false);
            }
        });
    };

    const enable = async () => {
        const publicKey = config.data?.publicKey;
        if (!ready || !publicKey) return;
        setFeedback(null);
        setServerRevoked(false);
        const result = await enableNotificationPush({
            prepare: async () => {
                const deviceId = notificationPushDeviceId();
                const prepared = await subscribeToNotifications(publicKey);
                return {
                    input: () =>
                        notificationPushRegistrationInput({
                            organizationId,
                            deviceId,
                            subscription: prepared.subscription,
                        }),
                    deviceId,
                    created: prepared.created,
                    unsubscribe: () => prepared.subscription.unsubscribe(),
                };
            },
            register: register.mutateAsync,
            writeReceipt: (receipt) =>
                writeNotificationPushReceipt(userId, organizationId, receipt),
        });
        browser.setPermission(browserPermission());
        browser.setReceipt(result.receipt);
        browser.setLocal(result.cleanupNeeded);
        setCleanupNeeded(result.cleanupNeeded);
        setFeedback(result.status);
    };

    const disable = async () => {
        setFeedback(null);
        const result = await disableNotificationPush({
            organizationId,
            receipt: browser.receipt,
            revoke: revoke.mutateAsync,
            unsubscribe: unsubscribeFromNotifications,
            writeReceipt: (receipt) =>
                writeNotificationPushReceipt(userId, organizationId, receipt),
            clearReceipt: () =>
                clearNotificationPushReceipt(userId, organizationId),
        });
        browser.setReceipt(result.receipt);
        browser.setLocal(!result.localRemoved);
        setCleanupNeeded(result.cleanupNeeded);
        setServerRevoked(result.serverRevoked);
        setFeedback(result.status);
    };

    return (
        <section
            className='space-y-3'
            aria-labelledby='notification-push-title'
            aria-busy={pending}
        >
            <div>
                <h3 id='notification-push-title' className='font-semibold'>
                    {t('title')}
                </h3>
                <p className='text-sm text-muted-foreground'>
                    {t('description')}
                </p>
            </div>
            <p className='text-sm text-muted-foreground'>
                {t('servicePolicy')}
            </p>
            {browser.checking || config.isPending ? (
                <p role='status'>{t('loading')}</p>
            ) : null}
            {ready ? null : (
                <p className='text-sm text-muted-foreground' role='status'>
                    {t(
                        browser.permission === 'denied'
                            ? 'denied'
                            : 'unavailable'
                    )}
                </p>
            )}
            {browser.checkFailed ? (
                <p role='alert' className='text-sm text-destructive'>
                    {t('checkFailed')}
                </p>
            ) : null}
            <div className='flex flex-wrap gap-2'>
                {cleanupAvailable ? (
                    <Button
                        type='button'
                        variant='outline'
                        disabled={pending || browser.checking}
                        onClick={() => run(disable)}
                    >
                        <BellOffIcon />
                        {t(pending ? 'updating' : 'disable')}
                    </Button>
                ) : null}
                {ready && !browser.receipt && !browser.checking ? (
                    <Button
                        type='button'
                        disabled={pending}
                        onClick={() => run(enable)}
                    >
                        <BellIcon />
                        {t(pending ? 'updating' : 'enable')}
                    </Button>
                ) : null}
                <Button
                    type='button'
                    variant='outline'
                    disabled={pending || browser.checking || config.isFetching}
                    onClick={() =>
                        run(async () => {
                            await Promise.all([
                                browser.refresh(),
                                config.refetch(),
                            ]);
                        })
                    }
                >
                    <RefreshCcwIcon />
                    {t('retry')}
                </Button>
            </div>
            {feedback ? (
                <p
                    className='text-sm'
                    role={
                        feedback === 'enabled' ||
                        feedback === 'disabled' ||
                        feedback === 'localOnly'
                            ? 'status'
                            : 'alert'
                    }
                >
                    {t(feedback)}
                </p>
            ) : null}
            {serverRevoked && feedback !== 'disabled' ? (
                <p className='text-sm' role='status'>
                    {t('serverRevoked')}
                </p>
            ) : null}
            <p className='text-xs text-muted-foreground'>
                {t('consentExplanation')}
            </p>
        </section>
    );
}
