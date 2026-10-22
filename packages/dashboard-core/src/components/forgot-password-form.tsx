'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@repo/ui/button';
import { Card, CardContent } from '@repo/ui/card';
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
            <Card className='overflow-hidden p-0'>
                <CardContent className='grid p-0 md:grid-cols-2'>
                    <form className='p-6 md:p-8' onSubmit={handleSubmit}>
                        <FieldGroup>
                            <div className='flex flex-col items-center gap-2 text-center'>
                                <h1 className='text-2xl font-bold'>
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
                                        <Button
                                            type='submit'
                                            disabled={isSubmitting}
                                        >
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
                    <div className='bg-muted relative hidden md:block'>
                        <div
                            className='absolute inset-0 flex flex-col items-center justify-center gap-6 bg-zinc-950 p-10 text-white'
                            aria-hidden='true'
                        >
                            <span className='text-8xl font-light tracking-tighter'>
                                V
                            </span>
                            <span className='text-xl font-medium tracking-wide'>
                                Vectorix
                            </span>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
