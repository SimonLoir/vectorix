'use client';
import { useState } from 'react';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import { toast } from 'sonner';
export function AccountProfile() {
    const auth = useAuth();
    const { data: session, refetch } = auth.useSession();
    const [busy, setBusy] = useState(false);
    return (
        <Card>
            <CardHeader>
                <CardTitle>Profil</CardTitle>
            </CardHeader>
            <CardContent>
                <form
                    className='space-y-4'
                    key={session?.user.id}
                    onSubmit={async (event) => {
                        event.preventDefault();
                        setBusy(true);
                        const data = new FormData(event.currentTarget);
                        try {
                            const result = await auth.updateUser({
                                name: String(data.get('name')),
                            });
                            if (result.error)
                                throw new Error(result.error.message);
                            const email = String(data.get('email'));
                            if (email !== session?.user.email) {
                                const changed = await auth.changeEmail({
                                    newEmail: email,
                                });
                                if (changed.error)
                                    throw new Error(changed.error.message);
                            }
                            await refetch();
                            toast.success('Profil enregistré');
                        } catch (error) {
                            toast.error(
                                error instanceof Error
                                    ? error.message
                                    : 'Enregistrement impossible'
                            );
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    <label className='block space-y-2'>
                        Nom
                        <Input
                            name='name'
                            defaultValue={session?.user.name}
                            required
                            maxLength={200}
                        />
                    </label>
                    <label className='block space-y-2'>
                        Adresse e-mail
                        <Input
                            name='email'
                            type='email'
                            defaultValue={session?.user.email}
                            required
                        />
                    </label>
                    <Button disabled={busy}>Enregistrer</Button>
                </form>
            </CardContent>
        </Card>
    );
}
