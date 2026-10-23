'use client';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@repo/ui/form';
import { Input } from '@repo/ui/input';
import { Button } from '@repo/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@repo/ui/select';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { toast } from 'sonner';
import { useState } from 'react';
import { CopyIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CopyToClipboardButton } from '@repo/dashboard-core/components/copy-to-clipboard-button';
import { invitationReviewPath } from '@repo/dashboard-core/lib/email-ownership';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { InvitationExpiry } from './invitation-expiry';
import { memberActionError } from './member-errors';
import { useMemberRoleLabel } from './member-role-label';

export default function InviteMemberForm({
    onSuccess,
}: Readonly<{
    onSuccess?: () => void;
}>) {
    const authClient = useAuth();
    const t = useTranslations('members');
    const roleLabel = useMemberRoleLabel();
    const inviteMemberSchema = z.object({
        email: z.string().email(t('form.invalidEmail')),
        role: z.string().min(1, t('form.requiredRole')),
    });
    const { access, can } = useVectorixPermissions();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [created, setCreated] = useState<{
        link: string;
        expiresAt: Date;
    } | null>(null);
    const form = useForm<z.infer<typeof inviteMemberSchema>>({
        resolver: zodResolver(inviteMemberSchema),
        defaultValues: {
            email: '',
            role: '',
        },
    });

    async function onSubmit(values: z.infer<typeof inviteMemberSchema>) {
        if (!can({ invitation: ['create'] })) {
            toast.error(t('errors.permission'));
            return;
        }
        setIsSubmitting(true);
        try {
            const { data, error } = await authClient.organization.inviteMember({
                email: values.email,
                role: values.role,
            });

            if (error) {
                toast.error(t(`errors.${memberActionError(error)}`));
            } else if (data) {
                const path = invitationReviewPath(data.id);
                if (!path) {
                    toast.error(t('errors.generic'));
                    return;
                }
                setCreated({
                    link: new URL(path, globalThis.location.origin).href,
                    expiresAt: data.expiresAt,
                });
                toast.success(t('form.createdToast', { email: values.email }));
            } else toast.error(t('errors.generic'));
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            setIsSubmitting(false);
        }
    }

    const handleClose = () => {
        form.reset();
        setCreated(null);
        onSuccess?.();
    };

    return (
        <Form {...form}>
            <form
                onSubmit={form.handleSubmit(onSubmit)}
                className='space-y-4 py-4'
                aria-busy={isSubmitting}
            >
                {created ? (
                    <div className='space-y-4'>
                        <div
                            role='status'
                            className='rounded-md bg-green-50 p-4 dark:bg-green-950'
                        >
                            <p className='text-sm font-medium text-green-800 dark:text-green-200'>
                                {t('form.created')}
                            </p>
                            <p className='text-sm text-green-700 dark:text-green-300 mt-1'>
                                {t('form.shareLink')}
                            </p>
                        </div>

                        <div className='space-y-2'>
                            <label
                                htmlFor='created-invitation-link'
                                className='text-sm font-medium'
                            >
                                {t('form.invitationLink')}
                            </label>
                            <div className='flex gap-2'>
                                <Input
                                    id='created-invitation-link'
                                    value={created.link}
                                    readOnly
                                    className='font-mono text-xs'
                                />
                                <CopyToClipboardButton
                                    type='button'
                                    copyText={created.link}
                                    variant='outline'
                                    aria-label={t('copyInvitationLink')}
                                >
                                    <CopyIcon
                                        aria-hidden='true'
                                        className='h-4 w-4 mr-2'
                                    />
                                    {t('copy')}
                                </CopyToClipboardButton>
                            </div>
                            <p className='text-sm font-medium'>
                                {t('expires')}
                            </p>
                            <InvitationExpiry expiresAt={created.expiresAt} />
                        </div>

                        <Button type='button' onClick={handleClose}>
                            {t('done')}
                        </Button>
                    </div>
                ) : (
                    <>
                        <FormField
                            control={form.control}
                            name='email'
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>
                                        {t('form.emailAddress')}
                                    </FormLabel>
                                    <FormControl>
                                        <Input
                                            type='email'
                                            placeholder={t(
                                                'form.emailPlaceholder'
                                            )}
                                            autoComplete='email'
                                            disabled={isSubmitting}
                                            {...field}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name='role'
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{t('role')}</FormLabel>
                                    <Select
                                        onValueChange={field.onChange}
                                        value={field.value}
                                        disabled={isSubmitting}
                                    >
                                        <FormControl>
                                            <SelectTrigger>
                                                <SelectValue
                                                    placeholder={t(
                                                        'form.selectRole'
                                                    )}
                                                />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            {access?.roles
                                                .filter(
                                                    (role) => role.assignable
                                                )
                                                .map((role) => (
                                                    <SelectItem
                                                        key={role.role}
                                                        value={role.role}
                                                    >
                                                        {roleLabel(role.role)}
                                                    </SelectItem>
                                                ))}
                                        </SelectContent>
                                    </Select>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <Button
                            type='submit'
                            disabled={
                                isSubmitting || !can({ invitation: ['create'] })
                            }
                        >
                            {t(isSubmitting ? 'form.creating' : 'form.create')}
                        </Button>
                    </>
                )}
            </form>
        </Form>
    );
}
