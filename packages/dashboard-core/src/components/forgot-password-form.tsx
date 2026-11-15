'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@repo/ui/button';
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@repo/ui/field';
import { Input } from '@repo/ui/input';
import { cn } from '@repo/ui/utils';
import { useAuth } from '../hooks/use-auth';

export function ForgotPasswordForm({
    className,
    ...props
}: React.ComponentProps<'div'>) {
    const authClient = useAuth();
    const t = useTranslations('forgotPassword');
    const [email, setEmail] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setIsSubmitting(true);

        try {
            await authClient.requestPasswordReset(
                {
                    email,
                },
                {
                    onSuccess: () => {
                        setIsSubmitted(true);
                        toast.success(t('resetLinkSent'));
                    },
                    onError: (ctx) => {
                        toast.error(
                            ctx.error.status === 503
                                ? t('temporarilyUnavailable')
                                : ctx.error.message || t('failedSendResetLink')
                        );
                    },
                }
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className={cn('flex flex-col gap-6', className)} {...props}>
            <form onSubmit={handleSubmit}>
                <FieldGroup>
                    <div className='flex flex-col gap-1.5'>
                        <h1 className='text-2xl font-semibold tracking-tight'>
                            {t('title')}
                        </h1>
                        <p className='text-muted-foreground text-sm text-balance'>
                            {isSubmitted
                                ? t('submittedDescription')
                                : t('description')}
                        </p>
                    </div>

                    {isSubmitted ? (
                        <Field>
                            <Button
                                type='button'
                                variant='secondary'
                                onClick={() => setIsSubmitted(false)}
                            >
                                {t('tryAnotherEmail')}
                            </Button>
                        </Field>
                    ) : (
                        <>
                            <Field>
                                <FieldLabel htmlFor='email'>
                                    {t('email')}
                                </FieldLabel>
                                <Input
                                    id='email'
                                    type='email'
                                    placeholder='m@example.com'
                                    value={email}
                                    onChange={(event) =>
                                        setEmail(event.target.value)
                                    }
                                    required
                                />
                            </Field>
                            <Field>
                                <Button type='submit' disabled={isSubmitting}>
                                    {isSubmitting
                                        ? t('sending')
                                        : t('sendResetLink')}
                                </Button>
                            </Field>
                        </>
                    )}

                    <FieldDescription className='text-center'>
                        <a href='/sign-in'>{t('backToSignIn')}</a>
                    </FieldDescription>
                </FieldGroup>
            </form>
        </div>
    );
}
