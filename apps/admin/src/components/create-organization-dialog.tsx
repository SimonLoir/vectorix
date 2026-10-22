'use client';
import { useTranslations } from 'next-intl';

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
    const tr = useTranslations('admin.core');
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
                toast.success(tr('organizationCreated'));
                setOpen(false);
                await queryClient.invalidateQueries();
                router.push(`/organizations/${organization.id}`);
            },
            onError: () => toast.error(tr('saveFailed')),
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
                    {tr('newOrganization')}
                </Button>
            </DialogTrigger>
            <DialogContent
                closeLabel={tr('close')}
                className='rounded-2xl border-white/10 bg-[#101827] p-0 sm:max-w-xl'
            >
                <DialogHeader className='rounded-t-2xl border-b border-white/8 bg-white/[0.025] px-6 py-5'>
                    <DialogTitle>{tr('createOrganization')}</DialogTitle>
                    <DialogDescription>
                        {tr('createOrganizationHint')}
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
                        <Label htmlFor='new-organization-name'>
                            {tr('name')}
                        </Label>
                        <Input
                            className='admin-field'
                            id='new-organization-name'
                            value={name}
                            placeholder={tr('organizationNamePlaceholder')}
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
                        <Label htmlFor='new-organization-slug'>
                            {tr('slug')}
                        </Label>
                        <Input
                            className='admin-field'
                            id='new-organization-slug'
                            value={slug}
                            placeholder={tr('slugPlaceholder')}
                            pattern='[a-z0-9]+(?:-[a-z0-9]+)*'
                            required
                            onChange={(event) => {
                                setSlugEdited(true);
                                setSlug(toSlug(event.target.value));
                            }}
                        />
                        <p className='text-xs text-muted-foreground'>
                            {tr('slugHint')}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button
                            type='button'
                            variant='outline'
                            onClick={() => setOpen(false)}
                        >
                            {tr('cancel')}
                        </Button>
                        <Button type='submit' disabled={mutation.isPending}>
                            {mutation.isPending
                                ? tr('creating')
                                : tr('createManage')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
