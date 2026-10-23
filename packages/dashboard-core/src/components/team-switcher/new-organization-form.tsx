'use client';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@repo/ui/form';
import { Input } from '@repo/ui/input';
import { Button } from '@repo/ui/button';
import { useAuth } from '../../hooks/use-auth';
import { toast } from 'sonner';
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
    invitationReviewPath,
    isInvitationId,
} from '../../lib/email-ownership';

export default function NewOrganizationForm({
    onCreate,
    allowOrganizationCreation = false,
}: Readonly<{
    onCreate?: () => void;
    allowOrganizationCreation?: boolean;
}>) {
    const authClient = useAuth();
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const t = useTranslations('orgForm');

    const newOrganizationSchema = z.object({
        name: z.string().min(1, t('nameRequired')),
        logo: z.string().optional(),
    });

    const joinOrganizationSchema = z.object({
        invitationId: z
            .string()
            .min(1, t('invitationIdRequired'))
            .refine(isInvitationId, t('invalidInvitationId')),
    });

    const createForm = useForm<z.infer<typeof newOrganizationSchema>>({
        resolver: zodResolver(newOrganizationSchema),
        defaultValues: { name: '' },
    });

    const joinForm = useForm<z.infer<typeof joinOrganizationSchema>>({
        resolver: zodResolver(joinOrganizationSchema),
        defaultValues: { invitationId: '' },
    });

    async function onCreateSubmit(
        values: z.infer<typeof newOrganizationSchema>
    ) {
        setIsSubmitting(true);
        try {
            const { data, error } = await authClient.organization.create({
                slug: values.name,
                name: values.name,
                logo: values.logo,
            });
            if (error) {
                toast.error(t('failedToCreate'));
                return;
            }

            toast.success(t('organizationCreated'));
            await authClient.organization.setActive({
                organizationId: data.id,
            });
            onCreate?.();
        } catch {
            toast.error(t('failedToCreate'));
        } finally {
            setIsSubmitting(false);
        }
    }

    function onJoinSubmit(values: z.infer<typeof joinOrganizationSchema>) {
        const path = invitationReviewPath(values.invitationId);
        if (!path) return;
        onCreate?.();
        router.push(path);
    }

    const joinOrganizationForm = (
        <Form {...joinForm}>
            <form
                onSubmit={joinForm.handleSubmit(onJoinSubmit)}
                className='space-y-4'
            >
                <FormField
                    control={joinForm.control}
                    name='invitationId'
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>{t('invitationId')}</FormLabel>
                            <FormControl>
                                <Input
                                    placeholder={t('enterInvitationId')}
                                    maxLength={128}
                                    {...field}
                                />
                            </FormControl>
                            <FormDescription>
                                {t('joinDescription')}
                            </FormDescription>
                            <FormMessage />
                        </FormItem>
                    )}
                />
                <Button type='submit' disabled={isSubmitting}>
                    {t('reviewInvitation')}
                </Button>
            </form>
        </Form>
    );

    if (!allowOrganizationCreation) {
        return joinOrganizationForm;
    }

    return (
        <Tabs defaultValue='create' className='w-full'>
            <TabsList className='grid w-full grid-cols-2'>
                <TabsTrigger value='create'>{t('create')}</TabsTrigger>
                <TabsTrigger value='join'>{t('join')}</TabsTrigger>
            </TabsList>
            <TabsContent value='create'>
                <Form {...createForm}>
                    <form
                        onSubmit={createForm.handleSubmit(onCreateSubmit)}
                        className='space-y-4'
                    >
                        <FormField
                            control={createForm.control}
                            name='name'
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>
                                        {t('organizationName')}
                                    </FormLabel>
                                    <FormControl>
                                        <Input
                                            placeholder='Vectorix'
                                            {...field}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <Button type='submit' disabled={isSubmitting}>
                            {isSubmitting
                                ? t('creating')
                                : t('createMyOrganization')}
                        </Button>
                    </form>
                </Form>
            </TabsContent>
            <TabsContent value='join'>{joinOrganizationForm}</TabsContent>
        </Tabs>
    );
}
