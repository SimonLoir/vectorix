'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@repo/ui/button';
import { Checkbox } from '@repo/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@repo/ui/dialog';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@repo/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs';
import { useORPC } from '@/hooks/use-orpc';

type AddMode = 'existing' | 'new';
type MemberRole = 'owner' | 'admin' | 'member';

function generatePassword() {
    const alphabet =
        'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const values = new Uint32Array(16);
    crypto.getRandomValues(values);
    return Array.from(
        values,
        (value) => alphabet[value % alphabet.length]
    ).join('');
}

export function AddOrganizationMemberDialog({
    organizationId,
}: {
    readonly organizationId: string;
}) {
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<AddMode>('existing');
    const [role, setRole] = useState<MemberRole>('member');
    const [password, setPassword] = useState('');
    const [emailVerified, setEmailVerified] = useState(false);
    const mutation = useMutation(
        orpc.superadmin.organizations.members.add.mutationOptions({
            onSuccess: async ({ userCreated }) => {
                toast.success(
                    userCreated
                        ? 'Utilisateur créé et ajouté à l’organisation'
                        : 'Utilisateur ajouté à l’organisation'
                );
                setOpen(false);
                await queryClient.invalidateQueries(
                    orpc.superadmin.organizations.get.queryOptions({
                        input: { organizationId },
                    })
                );
            },
            onError: (error) => toast.error(error.message),
        })
    );

    const reset = () => {
        setMode('existing');
        setRole('member');
        setPassword('');
        setEmailVerified(false);
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                setOpen(nextOpen);
                if (!nextOpen) reset();
            }}
        >
            <DialogTrigger asChild>
                <Button className='rounded-xl shadow-sm'>
                    <Plus className='h-4 w-4' />
                    Ajouter un membre
                </Button>
            </DialogTrigger>
            <DialogContent className='rounded-2xl border-white/10 bg-[#101827] p-0 sm:max-w-xl'>
                <DialogHeader>
                    <div className='rounded-t-2xl border-b border-white/8 bg-white/[0.025] px-6 py-5'>
                        <DialogTitle>Ajouter un membre</DialogTitle>
                        <DialogDescription className='mt-1'>
                            Liez un compte Vectorix existant ou créez un nouvel
                            utilisateur.
                        </DialogDescription>
                    </div>
                </DialogHeader>
                <div className='px-6'>
                    <Tabs
                        value={mode}
                        onValueChange={(value) => setMode(value as AddMode)}
                    >
                        <TabsList className='grid h-11 w-full grid-cols-2 rounded-xl'>
                            <TabsTrigger
                                value='existing'
                                className='rounded-lg'
                            >
                                Compte existant
                            </TabsTrigger>
                            <TabsTrigger value='new' className='rounded-lg'>
                                Nouvel utilisateur
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
                <form
                    className='space-y-5 px-6 pb-6'
                    onSubmit={(event) => {
                        event.preventDefault();
                        const formData = new FormData(event.currentTarget);
                        mutation.mutate({
                            organizationId,
                            email: String(formData.get('email') ?? ''),
                            role,
                            emailVerified,
                            ...(mode === 'new'
                                ? {
                                      name: String(formData.get('name') ?? ''),
                                      password,
                                  }
                                : {}),
                        });
                    }}
                >
                    {mode === 'new' ? (
                        <div className='space-y-2'>
                            <Label htmlFor='member-name'>Nom complet</Label>
                            <Input
                                className='admin-field'
                                id='member-name'
                                name='name'
                                placeholder='Marie Dupont'
                                required
                                autoFocus
                            />
                        </div>
                    ) : null}
                    <div className='space-y-2'>
                        <Label htmlFor='member-email'>Adresse e-mail</Label>
                        <Input
                            className='admin-field'
                            id='member-email'
                            name='email'
                            type='email'
                            placeholder='marie@exemple.be'
                            required
                            autoFocus={mode === 'existing'}
                        />
                    </div>
                    {mode === 'new' ? (
                        <div className='space-y-2'>
                            <Label htmlFor='member-password'>
                                Mot de passe temporaire
                            </Label>
                            <div className='flex gap-2'>
                                <Input
                                    className='admin-field'
                                    id='member-password'
                                    value={password}
                                    minLength={8}
                                    required
                                    onChange={(event) =>
                                        setPassword(event.target.value)
                                    }
                                />
                                <Button
                                    type='button'
                                    size='icon'
                                    variant='outline'
                                    title='Générer un mot de passe'
                                    onClick={() =>
                                        setPassword(generatePassword())
                                    }
                                >
                                    <RefreshCw className='h-4 w-4' />
                                </Button>
                                <Button
                                    type='button'
                                    size='icon'
                                    variant='outline'
                                    title='Copier le mot de passe'
                                    disabled={!password}
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(
                                            password
                                        );
                                        toast.success('Mot de passe copié');
                                    }}
                                >
                                    <Copy className='h-4 w-4' />
                                </Button>
                            </div>
                            <p className='text-xs text-muted-foreground'>
                                Communiquez-le de façon sécurisée à
                                l’utilisateur.
                            </p>
                        </div>
                    ) : null}
                    <div className='space-y-2'>
                        <Label>Rôle dans l’organisation</Label>
                        <Select
                            value={role}
                            onValueChange={(value) =>
                                setRole(value as MemberRole)
                            }
                        >
                            <SelectTrigger className='admin-field w-full'>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value='member'>Membre</SelectItem>
                                <SelectItem value='admin'>
                                    Administrateur
                                </SelectItem>
                                <SelectItem value='owner'>
                                    Propriétaire
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    {mode === 'new' ? (
                        <div className='flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4'>
                            <Checkbox
                                id='email-verified'
                                checked={emailVerified}
                                onCheckedChange={(checked) =>
                                    setEmailVerified(checked === true)
                                }
                            />
                            <div>
                                <Label htmlFor='email-verified'>
                                    E-mail déjà vérifié
                                </Label>
                                <p className='mt-1 text-xs text-muted-foreground'>
                                    À activer uniquement si l’adresse a été
                                    confirmée par un autre moyen.
                                </p>
                            </div>
                        </div>
                    ) : null}
                    <DialogFooter>
                        <Button
                            type='button'
                            variant='outline'
                            onClick={() => setOpen(false)}
                        >
                            Annuler
                        </Button>
                        <Button type='submit' disabled={mutation.isPending}>
                            {mutation.isPending
                                ? 'Ajout…'
                                : mode === 'new'
                                  ? 'Créer et ajouter'
                                  : 'Ajouter'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
