'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BellIcon, BellOffIcon, RefreshCcwIcon, SaveIcon } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VectorixApiV1Outputs } from '@repo/api';
import { Button } from '@repo/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@repo/ui/card';
import { Checkbox } from '@repo/ui/checkbox';
import { Separator } from '@repo/ui/separator';
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
} from '@/lib/notification-push';

type PreferencesResult =
    VectorixApiV1Outputs['admin']['notifications']['preferences']['get'];
type Preference = PreferencesResult['preferences'][number];
type EventType = Preference['eventType'];
type Channel = Preference['channel'];
type Draft = Record<string, boolean>;

const CHANNELS = [
    'IN_APP',
    'PUSH',
    'EMAIL',
] as const satisfies readonly Channel[];

const EVENT_GROUPS = [{ id: 'security', events: ['ACCOUNT_SIGN_IN'] }] as const;

function preferenceKey(eventType: EventType, channel: Channel) {
    return `${eventType}:${channel}`;
}

function makeDraft(result: PreferencesResult): Draft {
    return Object.fromEntries(
        result.preferences.map((preference) => [
            preferenceKey(preference.eventType, preference.channel),
            preference.enabled,
        ])
    );
}

function preferenceSignature(result: PreferencesResult) {
    return JSON.stringify(
        result.preferences.map(
            ({ eventType, channel, enabled, version, updatedAt }) => [
                eventType,
                channel,
                enabled,
                version,
                updatedAt,
            ]
        )
    );
}

function isConflict(error: unknown) {
    if (typeof error !== 'object' || error === null) return false;
    if ('code' in error && error.code === 'CONFLICT') return true;
    if ('message' in error && typeof error.message === 'string')
        return error.message.includes('CONFLICT');
    return false;
}

/** Personal notification choices for one immutable user/session/organization scope. */
export function NotificationPreferences({
    organizationId,
    userId,
    sessionId,
}: Readonly<{
    organizationId: string;
    userId: string;
    sessionId: string;
}>) {
    const t = useTranslations('notifications.preferences');
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const [snapshot, setSnapshot] = useState<PreferencesResult | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [remoteChange, setRemoteChange] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);
    const [saved, setSaved] = useState(false);
    const [reloading, setReloading] = useState(false);

    const options = orpc.admin.notifications.preferences.get.queryOptions({});
    const queryKey = [
        ...options.queryKey,
        'member-scope',
        userId,
        sessionId,
        organizationId,
    ] as const;
    const dirty = Boolean(
        snapshot &&
        draft &&
        snapshot.preferences.some(
            (preference) =>
                draft[
                    preferenceKey(preference.eventType, preference.channel)
                ] !== preference.enabled
        )
    );
    const query = useQuery({
        ...options,
        queryKey,
        enabled: !dirty && !reloading,
        staleTime: 0,
        refetchOnReconnect: 'always',
        refetchOnWindowFocus: 'always',
        retry: false,
    });
    const update = useMutation(
        orpc.admin.notifications.preferences.update.mutationOptions({})
    );

    const adopt = useCallback((result: PreferencesResult) => {
        setSnapshot(result);
        setDraft(makeDraft(result));
        setRemoteChange(false);
        setSaveFailed(false);
    }, []);

    useEffect(() => {
        if (!query.data) return;
        let active = true;
        const result = query.data;
        globalThis.queueMicrotask(() => {
            if (!active) return;
            if (!snapshot || !draft || !dirty) adopt(result);
            else if (
                preferenceSignature(result) !== preferenceSignature(snapshot)
            )
                setRemoteChange(true);
        });
        return () => {
            active = false;
        };
        // A local edit intentionally does not retrigger adoption of the last response.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query.data]);

    const byKey = useMemo(
        () =>
            new Map(
                snapshot?.preferences.map((preference) => [
                    preferenceKey(preference.eventType, preference.channel),
                    preference,
                ])
            ),
        [snapshot]
    );

    const save = async () => {
        if (!snapshot || !draft || !dirty) return;
        const changes = snapshot.preferences.flatMap((preference) => {
            const enabled =
                draft[preferenceKey(preference.eventType, preference.channel)];
            return enabled === preference.enabled || enabled === undefined
                ? []
                : [
                      {
                          eventType: preference.eventType,
                          channel: preference.channel,
                          enabled,
                          expectedVersion: preference.version,
                      },
                  ];
        });
        if (!changes.length) return;
        setSaveFailed(false);
        setRemoteChange(false);
        setSaved(false);
        try {
            const result = await update.mutateAsync({
                expectedOrganizationId: organizationId,
                changes,
            });
            adopt(result);
            queryClient.setQueryData(queryKey, result);
            setSaved(true);
        } catch (error) {
            setSaveFailed(true);
            if (isConflict(error)) setRemoteChange(true);
        }
    };

    const reload = async () => {
        if (dirty && !globalThis.confirm(t('reloadConfirm'))) return;
        setReloading(true);
        setSaved(false);
        try {
            const result = await query.refetch();
            if (result.data) adopt(result.data);
        } finally {
            setReloading(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('title')}</CardTitle>
                <CardDescription>{t('description')}</CardDescription>
            </CardHeader>
            <CardContent className='space-y-6'>
                {query.isPending && !snapshot ? (
                    <p className='text-sm text-muted-foreground'>
                        {t('loading')}
                    </p>
                ) : null}
                {query.isError && !snapshot ? (
                    <div className='space-y-3' role='alert'>
                        <p className='text-sm text-destructive'>
                            {t('loadError')}
                        </p>
                        <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            disabled={reloading}
                            onClick={() => void reload()}
                        >
                            <RefreshCcwIcon />
                            {t('reload')}
                        </Button>
                    </div>
                ) : null}
                {snapshot && draft ? (
                    <form
                        className='space-y-6'
                        onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                        }}
                    >
                        <div className='overflow-x-auto rounded-lg border'>
                            <div className='min-w-[640px]'>
                                <div className='grid grid-cols-[minmax(16rem,1fr)_repeat(3,7rem)] items-center gap-2 border-b bg-muted/40 px-4 py-3 text-sm font-medium'>
                                    <span>{t('event')}</span>
                                    {CHANNELS.map((channel) => (
                                        <span
                                            key={channel}
                                            className='text-center'
                                        >
                                            {t(`channels.${channel}`)}
                                        </span>
                                    ))}
                                </div>
                                {EVENT_GROUPS.map((group) => (
                                    <fieldset key={group.id}>
                                        <legend className='w-full border-b bg-muted/20 px-4 py-2 text-sm font-semibold'>
                                            {t(`groups.${group.id}`)}
                                        </legend>
                                        {group.events.map((eventType) => (
                                            <div
                                                key={eventType}
                                                className='grid grid-cols-[minmax(16rem,1fr)_repeat(3,7rem)] items-center gap-2 border-b px-4 py-3 last:border-b-0'
                                            >
                                                <div>
                                                    <p className='text-sm font-medium'>
                                                        {t(
                                                            `events.${eventType}.label`
                                                        )}
                                                    </p>
                                                    <p className='text-xs text-muted-foreground'>
                                                        {t(
                                                            `events.${eventType}.description`
                                                        )}
                                                    </p>
                                                </div>
                                                {CHANNELS.map((channel) => {
                                                    const key = preferenceKey(
                                                        eventType,
                                                        channel
                                                    );
                                                    const preference =
                                                        byKey.get(key);
                                                    return (
                                                        <div
                                                            key={channel}
                                                            className='flex flex-col items-center gap-1'
                                                        >
                                                            <Checkbox
                                                                id={`notification-${key}`}
                                                                checked={
                                                                    draft[
                                                                        key
                                                                    ] ?? false
                                                                }
                                                                disabled={
                                                                    update.isPending ||
                                                                    !preference
                                                                }
                                                                aria-label={t(
                                                                    'toggleLabel',
                                                                    {
                                                                        event: t(
                                                                            `events.${eventType}.label`
                                                                        ),
                                                                        channel:
                                                                            t(
                                                                                `channels.${channel}`
                                                                            ),
                                                                    }
                                                                )}
                                                                onCheckedChange={(
                                                                    checked
                                                                ) => {
                                                                    setDraft(
                                                                        (
                                                                            current
                                                                        ) =>
                                                                            current
                                                                                ? {
                                                                                      ...current,
                                                                                      [key]: Boolean(
                                                                                          checked
                                                                                      ),
                                                                                  }
                                                                                : current
                                                                    );
                                                                    setSaved(
                                                                        false
                                                                    );
                                                                }}
                                                            />
                                                            {preference?.version ===
                                                            null ? (
                                                                <span className='text-[0.6875rem] text-muted-foreground'>
                                                                    {t(
                                                                        'default'
                                                                    )}
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ))}
                                    </fieldset>
                                ))}
                            </div>
                        </div>

                        <p className='text-sm text-muted-foreground'>
                            {t('accountEmailExplanation')}
                        </p>
                        {(remoteChange || saveFailed) && (
                            <div
                                className='rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm'
                                role='alert'
                            >
                                <p>
                                    {remoteChange
                                        ? t('conflict')
                                        : t('saveError')}
                                </p>
                                <Button
                                    type='button'
                                    variant='outline'
                                    size='sm'
                                    className='mt-3'
                                    disabled={reloading || update.isPending}
                                    onClick={() => void reload()}
                                >
                                    <RefreshCcwIcon />
                                    {t('reload')}
                                </Button>
                            </div>
                        )}
                        {saved ? (
                            <p className='text-sm text-primary' role='status'>
                                {t('saved')}
                            </p>
                        ) : null}
                        <Button
                            type='submit'
                            disabled={!dirty || update.isPending || reloading}
                        >
                            <SaveIcon />
                            {update.isPending ? t('saving') : t('save')}
                        </Button>
                    </form>
                ) : null}

                <Separator />
                <NotificationPushControls
                    organizationId={organizationId}
                    userId={userId}
                />
            </CardContent>
        </Card>
    );
}

type PushConfig = Readonly<{ enabled: boolean; publicKey: string | null }>;

type RegisterPush = (
    input: ReturnType<typeof notificationPushRegistrationInput>
) => Promise<{ id: string; version: number }>;

type RevokePush = (input: {
    id: string;
    expectedOrganizationId: string;
    expectedVersion: number;
}) => Promise<unknown>;

async function loadPushConfig(signal: AbortSignal) {
    const response = await fetch('/api/notification-push-config', { signal });
    if (!response.ok) throw new Error('PUSH_CONFIG_UNAVAILABLE');
    const value = (await response.json()) as PushConfig;
    if (
        typeof value.enabled !== 'boolean' ||
        (value.publicKey !== null && typeof value.publicKey !== 'string')
    )
        throw new Error('PUSH_CONFIG_INVALID');
    return value;
}

async function enableNotificationPush({
    publicKey,
    organizationId,
    userId,
    register,
}: Readonly<{
    publicKey: string;
    organizationId: string;
    userId: string;
    register: RegisterPush;
}>) {
    let subscription: PushSubscription | null = null;
    try {
        subscription = await subscribeToNotifications(publicKey);
        const deviceId = notificationPushDeviceId();
        const registered = await register(
            notificationPushRegistrationInput({
                organizationId,
                deviceId,
                subscription,
            })
        );
        writeNotificationPushReceipt(userId, organizationId, {
            id: registered.id,
            version: registered.version,
            deviceId,
        });
        return true;
    } catch {
        if (subscription) await subscription.unsubscribe().catch(() => false);
        return false;
    }
}

async function disableNotificationPush({
    organizationId,
    userId,
    register,
    revoke,
}: Readonly<{
    organizationId: string;
    userId: string;
    register: RegisterPush;
    revoke: RevokePush;
}>) {
    let serverRevoked = false;
    let failed = false;
    try {
        const subscription = await currentNotificationPushSubscription();
        let receipt = readNotificationPushReceipt(userId, organizationId);
        if (subscription) {
            const deviceId = receipt?.deviceId ?? notificationPushDeviceId();
            const registered = await register(
                notificationPushRegistrationInput({
                    organizationId,
                    deviceId,
                    subscription,
                })
            );
            receipt = {
                id: registered.id,
                version: registered.version,
                deviceId,
            };
        }
        if (receipt) {
            await revoke({
                id: receipt.id,
                expectedOrganizationId: organizationId,
                expectedVersion: receipt.version,
            });
            serverRevoked = true;
        }
    } catch {
        failed = true;
    }
    try {
        await unsubscribeFromNotifications();
    } catch {
        failed = true;
    }
    clearNotificationPushReceipt(userId, organizationId);
    return serverRevoked && !failed;
}

function useBrowserPushRegistration(userId: string, organizationId: string) {
    const [active, setActive] = useState(false);
    const [permission, setPermission] = useState<NotificationPermission | null>(
        null
    );
    const support = notificationPushSupport();

    useEffect(() => {
        if (!support.supported) return;
        let current = true;
        void currentNotificationPushSubscription()
            .then((subscription) => {
                if (!current) return;
                const receipt = readNotificationPushReceipt(
                    userId,
                    organizationId
                );
                setPermission(Notification.permission);
                setActive(Boolean(subscription && receipt));
            })
            .catch(() => {
                if (!current) return;
                setPermission(Notification.permission);
                setActive(false);
            });
        return () => {
            current = false;
        };
    }, [organizationId, support.supported, userId]);

    return { active, setActive, permission, setPermission, support };
}

function PushControlAction({
    loading,
    unavailable,
    denied,
    active,
    pending,
    onToggle,
    labels,
}: Readonly<{
    loading: boolean;
    unavailable: boolean;
    denied: boolean;
    active: boolean;
    pending: boolean;
    onToggle: () => void;
    labels: Readonly<{
        loading: string;
        unavailable: string;
        denied: string;
        updating: string;
        disable: string;
        enable: string;
    }>;
}>) {
    if (loading)
        return (
            <p className='text-sm text-muted-foreground'>{labels.loading}</p>
        );
    if (unavailable)
        return (
            <p className='text-sm text-muted-foreground' role='status'>
                {labels.unavailable}
            </p>
        );
    if (denied)
        return (
            <p className='text-sm text-destructive' role='alert'>
                {labels.denied}
            </p>
        );
    return (
        <Button
            type='button'
            variant={active ? 'outline' : 'default'}
            disabled={pending}
            onClick={onToggle}
        >
            {active ? <BellOffIcon /> : <BellIcon />}
            {pending
                ? labels.updating
                : active
                  ? labels.disable
                  : labels.enable}
        </Button>
    );
}

function NotificationPushControls({
    organizationId,
    userId,
}: Readonly<{ organizationId: string; userId: string }>) {
    const t = useTranslations('notifications.preferences.push');
    const { orpc } = useORPC();
    const [error, setError] = useState(false);
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
    const pending = register.isPending || revoke.isPending;
    const { active, setActive, permission, setPermission, support } =
        useBrowserPushRegistration(userId, organizationId);

    const activate = async () => {
        if (!config.data?.enabled || !config.data.publicKey) return;
        setError(false);
        const enabled = await enableNotificationPush({
            publicKey: config.data.publicKey,
            organizationId,
            userId,
            register: register.mutateAsync,
        });
        setPermission(Notification.permission);
        setActive(enabled);
        setError(!enabled);
    };

    const deactivate = async () => {
        setError(false);
        const disabled = await disableNotificationPush({
            organizationId,
            userId,
            register: register.mutateAsync,
            revoke: revoke.mutateAsync,
        });
        setActive(false);
        setError(!disabled);
    };

    const unavailable =
        !support.supported ||
        config.isError ||
        (!active &&
            config.data &&
            (!config.data.enabled || !config.data.publicKey));

    return (
        <section
            className='space-y-3'
            aria-labelledby='notification-push-title'
        >
            <div>
                <h3 id='notification-push-title' className='font-semibold'>
                    {t('title')}
                </h3>
                <p className='text-sm text-muted-foreground'>
                    {t('description')}
                </p>
            </div>
            <PushControlAction
                loading={config.isPending}
                unavailable={Boolean(unavailable)}
                denied={permission === 'denied' && !active}
                active={active}
                pending={pending}
                onToggle={() => void (active ? deactivate() : activate())}
                labels={{
                    loading: t('loading'),
                    unavailable: t('unavailable'),
                    denied: t('denied'),
                    updating: t('updating'),
                    disable: t('disable'),
                    enable: t('enable'),
                }}
            />
            {error ? (
                <p className='text-sm text-destructive' role='alert'>
                    {t('error')}
                </p>
            ) : null}
            <p className='text-xs text-muted-foreground'>
                {t('consentExplanation')}
            </p>
        </section>
    );
}
