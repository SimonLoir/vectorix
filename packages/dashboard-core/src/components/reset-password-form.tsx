'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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

type ResetPasswordFormProps = React.ComponentProps<'div'> & {
    token?: string | null;
    resetError?: string | null;
};

export function ResetPasswordForm({
    token,
    resetError,
    className,
    ...props
}: ResetPasswordFormProps) {
    const router = useRouter();
    const authClient = useAuth();
    const t = useTranslations('resetPassword');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isReset, setIsReset] = useState(false);

    const hasInvalidToken = !token || resetError === 'INVALID_TOKEN';

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        if (!token) {
            toast.error(t('invalidToken'));
            return;
        }

        if (password !== confirmPassword) {
            toast.error(t('passwordsNoMatch'));
            return;
        }

        if (password.length < 8) {
            toast.error(t('passwordTooShort'));
            return;
        }

        setIsSubmitting(true);

        try {
            await authClient.resetPassword(
                {
                    newPassword: password,
                    token,
                },
                {
                    onSuccess: () => {
                        setIsReset(true);
                        toast.success(t('passwordReset'));
                    },
                    onError: (ctx) => {
                        toast.error(
                            ctx.error.message || t('failedResetPassword')
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
                                    {hasInvalidToken
                                        ? t('invalidTokenDescription')
                                        : isReset
                                          ? t('successDescription')
                                          : t('description')}
                                </p>
                            </div>

                            {hasInvalidToken || isReset ? (
                                <Field>
                                    <Button
                                        type='button'
                                        onClick={() => router.push('/sign-in')}
                                    >
                                        {t('backToSignIn')}
                                    </Button>
                                </Field>
                            ) : (
                                <>
                                    <Field>
                                        <FieldLabel htmlFor='password'>
                                            {t('password')}
                                        </FieldLabel>
                                        <Input
                                            id='password'
                                            type='password'
                                            value={password}
                                            onChange={(event) =>
                                                setPassword(event.target.value)
                                            }
                                            required
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel htmlFor='confirm-password'>
                                            {t('confirmPassword')}
                                        </FieldLabel>
                                        <Input
                                            id='confirm-password'
                                            type='password'
                                            value={confirmPassword}
                                            onChange={(event) =>
                                                setConfirmPassword(
                                                    event.target.value
                                                )
                                            }
                                            required
                                        />
                                        <FieldDescription>
                                            {t('passwordRequirement')}
                                        </FieldDescription>
                                    </Field>
                                    <Field>
                                        <Button
                                            type='submit'
                                            disabled={isSubmitting}
                                        >
                                            {isSubmitting
                                                ? t('resetting')
                                                : t('resetPassword')}
                                        </Button>
                                    </Field>
                                </>
                            )}
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
