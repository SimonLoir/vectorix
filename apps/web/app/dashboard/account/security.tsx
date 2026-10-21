'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import { toast } from 'sonner';
export function AccountSecurity() {
    const auth = useAuth();
    const { data: session } = auth.useSession();
    const [busy, setBusy] = useState(false);
    const passkeys = useQuery({
        queryKey: ['account-passkeys', session?.user.id],
        queryFn: async () => {
            const result = await auth.passkey.listUserPasskeys();
            if (result.error) throw new Error(result.error.message);
            return result.data ?? [];
        },
        enabled: Boolean(session),
    });
    const sessions = useQuery({
        queryKey: ['account-sessions', session?.user.id],
        queryFn: async () => {
            const result = await auth.listSessions();
            if (result.error) throw new Error(result.error.message);
            return result.data ?? [];
        },
        enabled: Boolean(session),
    });
    async function action(
        operation: () => Promise<{ error?: { message?: string } | null }>
    ) {
        setBusy(true);
        try {
            const result = await operation();
            if (result.error) throw new Error(result.error.message);
            await Promise.all([passkeys.refetch(), sessions.refetch()]);
            toast.success('Modification enregistrée');
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : 'Opération impossible'
            );
        } finally {
            setBusy(false);
        }
    }
    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle>Mot de passe</CardTitle>
                </CardHeader>
                <CardContent>
                    <form
                        className='space-y-4'
                        onSubmit={async (event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            const data = new FormData(form);
                            if (data.get('next') !== data.get('confirm')) {
                                toast.error(
                                    'Les mots de passe ne correspondent pas'
                                );
                                return;
                            }
                            await action(() =>
                                auth.changePassword({
                                    currentPassword: String(
                                        data.get('current')
                                    ),
                                    newPassword: String(data.get('next')),
                                    revokeOtherSessions: true,
                                })
                            );
                            form.reset();
                        }}
                    >
                        <label className='block'>
                            Mot de passe actuel
                            <Input
                                name='current'
                                type='password'
                                autoComplete='current-password'
                                required
                            />
                        </label>
                        <label className='block'>
                            Nouveau mot de passe
                            <Input
                                name='next'
                                type='password'
                                minLength={8}
                                autoComplete='new-password'
                                required
                            />
                        </label>
                        <label className='block'>
                            Confirmation
                            <Input
                                name='confirm'
                                type='password'
                                autoComplete='new-password'
                                required
                            />
                        </label>
                        <Button disabled={busy}>Changer le mot de passe</Button>
                    </form>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Passkeys</CardTitle>
                </CardHeader>
                <CardContent className='space-y-4'>
                    {passkeys.isError && (
                        <p role='alert'>{passkeys.error.message}</p>
                    )}
                    {passkeys.data?.map((key) => (
                        <div className='flex justify-between' key={key.id}>
                            <span>{key.name ?? 'Passkey'}</span>
                            <Button
                                variant='outline'
                                disabled={busy}
                                onClick={() =>
                                    action(() =>
                                        auth.passkey.deletePasskey({
                                            id: key.id,
                                        })
                                    )
                                }
                            >
                                Supprimer
                            </Button>
                        </div>
                    ))}
                    <Button
                        disabled={busy}
                        onClick={() =>
                            action(() =>
                                auth.passkey.addPasskey({
                                    name: 'Mon appareil',
                                })
                            )
                        }
                    >
                        Ajouter une passkey
                    </Button>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Sessions</CardTitle>
                </CardHeader>
                <CardContent className='space-y-4'>
                    {sessions.isError && (
                        <p role='alert'>{sessions.error.message}</p>
                    )}
                    {sessions.data?.map((item) => (
                        <div
                            key={item.id}
                            className='flex items-center justify-between gap-4'
                        >
                            <span className='truncate text-sm'>
                                {item.userAgent ?? 'Appareil inconnu'}{' '}
                                {item.id === session?.session.id &&
                                    '(session actuelle)'}
                            </span>
                            {item.id !== session?.session.id && (
                                <Button
                                    variant='outline'
                                    disabled={busy}
                                    onClick={() =>
                                        action(() =>
                                            auth.revokeSession({
                                                token: item.token,
                                            })
                                        )
                                    }
                                >
                                    Révoquer
                                </Button>
                            )}
                        </div>
                    ))}
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Supprimer mon compte</CardTitle>
                </CardHeader>
                <CardContent>
                    <Button
                        variant='destructive'
                        disabled={busy}
                        onClick={async () => {
                            if (
                                !globalThis.confirm(
                                    'Supprimer définitivement votre compte ?'
                                )
                            )
                                return;
                            const password = globalThis.prompt(
                                'Confirmez votre mot de passe'
                            );
                            if (!password) return;
                            await action(async () => {
                                const result = await auth.deleteUser({
                                    password,
                                });
                                if (!result.error)
                                    globalThis.location.assign('/sign-in');
                                return result;
                            });
                        }}
                    >
                        Supprimer mon compte
                    </Button>
                </CardContent>
            </Card>
        </>
    );
}
