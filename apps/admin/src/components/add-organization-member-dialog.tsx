'use client';
import { useTranslations } from 'next-intl';

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
    const tr = useTranslations('admin.core');
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
                    userCreated ? tr('userCreatedAdded') : tr('userAdded')
                );
                setOpen(false);
                await queryClient.invalidateQueries(
                    orpc.superadmin.organizations.get.queryOptions({
                        input: { organizationId },
                    })
                );
            },
            onError: () => toast.error(tr('saveFailed')),
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
                    {tr('addMember')}
                </Button>
            </DialogTrigger>
            <DialogContent
                closeLabel={tr('close')}
                className='rounded-2xl border-white/10 bg-[#101827] p-0 sm:max-w-xl'
            >
                <DialogHeader>
                    <div className='rounded-t-2xl border-b border-white/8 bg-white/[0.025] px-6 py-5'>
                        <DialogTitle>{tr('addMember')}</DialogTitle>
                        <DialogDescription className='mt-1'>
                            {tr('addMemberHint')}
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
                                {tr('existingAccount')}
                            </TabsTrigger>
                            <TabsTrigger value='new' className='rounded-lg'>
                                {tr('newUser')}
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
                            <Label htmlFor='member-name'>
                                {tr('fullName')}
                            </Label>
                            <Input
                                className='admin-field'
                                id='member-name'
                                name='name'
                                placeholder={tr('namePlaceholder')}
                                required
                                autoFocus
                            />
                        </div>
                    ) : null}
                    <div className='space-y-2'>
                        <Label htmlFor='member-email'>{tr('email')}</Label>
                        <Input
                            className='admin-field'
                            id='member-email'
                            name='email'
                            type='email'
                            placeholder={tr('emailPlaceholder')}
                            required
                            autoFocus={mode === 'existing'}
                        />
                    </div>
                    {mode === 'new' ? (
                        <div className='space-y-2'>
                            <Label htmlFor='member-password'>
                                {tr('temporaryPassword')}
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
                                    title={tr('generatePassword')}
                                    aria-label={tr('generatePassword')}
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
                                    title={tr('copyPassword')}
                                    aria-label={tr('copyPassword')}
                                    disabled={!password}
                                    onClick={async () => {
                                        try {
                                            await navigator.clipboard.writeText(
                                                password
                                            );
                                            toast.success(tr('passwordCopied'));
                                        } catch {
                                            toast.error(tr('clipboardFailed'));
                                        }
                                    }}
                                >
                                    <Copy className='h-4 w-4' />
                                </Button>
                            </div>
                            <p className='text-xs text-muted-foreground'>
                                {tr('passwordHint')}
                            </p>
                        </div>
                    ) : null}
                    <div className='space-y-2'>
                        <Label>{tr('organizationRole')}</Label>
                        <Select
                            value={role}
                            onValueChange={(value) =>
                                setRole(value as MemberRole)
                            }
                        >
                            <SelectTrigger
                                aria-label={tr('organizationRole')}
                                className='admin-field w-full'
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value='member'>
                                    {tr('member')}
                                </SelectItem>
                                <SelectItem value='admin'>
                                    {tr('administrator')}
                                </SelectItem>
                                <SelectItem value='owner'>
                                    {tr('owner')}
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
                                    {tr('emailVerified')}
                                </Label>
                                <p className='mt-1 text-xs text-muted-foreground'>
                                    {tr('emailVerifiedHint')}
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
                            {tr('cancel')}
                        </Button>
                        <Button type='submit' disabled={mutation.isPending}>
                            {mutation.isPending
                                ? tr('adding')
                                : mode === 'new'
                                  ? tr('createAdd')
                                  : tr('add')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
