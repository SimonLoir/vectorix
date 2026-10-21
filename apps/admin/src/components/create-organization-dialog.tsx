'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@repo/ui/button';
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
import { useORPC } from '@/hooks/use-orpc';

function toSlug(value: string) {
    return value
        .normalize('NFD')
        .replaceAll(/[\u{300}-\u{36F}]/gu, '')
        .toLowerCase()
        .trim()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, '');
}

export function CreateOrganizationDialog() {
    const { orpc } = useORPC();
    const router = useRouter();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [slugEdited, setSlugEdited] = useState(false);
    const mutation = useMutation(
        orpc.superadmin.organizations.create.mutationOptions({
            onSuccess: async (organization) => {
                toast.success('Organisation créée');
                setOpen(false);
                await queryClient.invalidateQueries();
                router.push(`/organizations/${organization.id}`);
            },
            onError: (error) => toast.error(error.message),
        })
    );

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                setOpen(nextOpen);
                if (nextOpen) return;
                setName('');
                setSlug('');
                setSlugEdited(false);
            }}
        >
            <DialogTrigger asChild>
                <Button className='rounded-xl shadow-sm'>
                    <Plus className='h-4 w-4' />
                    Nouvelle organisation
                </Button>
            </DialogTrigger>
            <DialogContent className='rounded-2xl border-white/10 bg-[#101827] p-0 sm:max-w-xl'>
                <DialogHeader className='rounded-t-2xl border-b border-white/8 bg-white/[0.025] px-6 py-5'>
                    <DialogTitle>Créer une organisation</DialogTitle>
                    <DialogDescription>
                        Créez le compte, puis ajoutez ses propriétaires et
                        membres depuis sa fiche.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className='space-y-5 px-6 pb-6'
                    onSubmit={(event) => {
                        event.preventDefault();
                        mutation.mutate({ name, slug, isActive: true });
                    }}
                >
                    <div className='space-y-2'>
                        <Label htmlFor='new-organization-name'>Nom</Label>
                        <Input
                            className='admin-field'
                            id='new-organization-name'
                            value={name}
                            placeholder='Mon organisation'
                            autoFocus
                            required
                            onChange={(event) => {
                                const value = event.target.value;
                                setName(value);
                                if (!slugEdited) setSlug(toSlug(value));
                            }}
                        />
                    </div>
                    <div className='space-y-2'>
                        <Label htmlFor='new-organization-slug'>Slug</Label>
                        <Input
                            className='admin-field'
                            id='new-organization-slug'
                            value={slug}
                            placeholder='mon-organisation'
                            pattern='[a-z0-9]+(?:-[a-z0-9]+)*'
                            required
                            onChange={(event) => {
                                setSlugEdited(true);
                                setSlug(toSlug(event.target.value));
                            }}
                        />
                        <p className='text-xs text-muted-foreground'>
                            Identifiant stable utilisé dans les URLs publiques.
                        </p>
                    </div>
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
                                ? 'Création…'
                                : 'Créer et gérer'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
