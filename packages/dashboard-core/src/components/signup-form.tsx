'use client';

import { cn } from '@repo/ui/utils';
import { Button } from '@repo/ui/button';
import { Card, CardContent } from '@repo/ui/card';
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldSeparator,
} from '@repo/ui/field';
import { Input } from '@repo/ui/input';
import { useState } from 'react';
import { useAuth } from '../hooks/use-auth';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { emailOwnershipSignInReturn } from '../lib/email-ownership';

/** Native signup preserves only the explicitly allowlisted email-flow resume. */
export function SignupForm({
    className,
    successRedirectPath = '/',
    ...props
}: React.ComponentProps<'div'> & { readonly successRedirectPath?: string }) {
    const authClient = useAuth();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const router = useRouter();
    const t = useTranslations('signup');
    const [busy, setBusy] = useState(false);
    const returnTo = emailOwnershipSignInReturn(successRedirectPath);
    const signInHref =
        returnTo === '/dashboard'
            ? '/sign-in'
            : `/sign-in?${new URLSearchParams({ returnTo })}`;

    return (
        <div className={cn('flex flex-col gap-6', className)} {...props}>
            <Card className='overflow-hidden p-0'>
                <CardContent className='grid p-0 md:grid-cols-2'>
                    <form
                        className='p-6 md:p-8'
                        onSubmit={async (e) => {
                            e.preventDefault();
                            setBusy(true);
                            try {
                                await authClient.signUp.email(
                                    {
                                        email,
                                        password,
                                        name,
                                    },
                                    {
                                        onSuccess: () => {
                                            toast.success(
                                                t('signupSuccessful')
                                            );
                                            void router.push(
                                                successRedirectPath
                                            );
                                        },
                                        onError: () => {
                                            toast.error(t('signupFailed'));
                                        },
                                    }
                                );
                            } catch {
                                toast.error(t('signupFailed'));
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        <FieldGroup>
                            <div className='flex flex-col items-center gap-2 text-center'>
                                <h1 className='text-2xl font-bold'>
                                    {t('welcome')}
                                </h1>
                                <p className='text-muted-foreground text-sm text-balance'>
                                    {t('enterEmail')}
                                </p>
                            </div>
                            <Field>
                                <FieldLabel htmlFor='name'>
                                    {t('name')}
                                </FieldLabel>
                                <Input
                                    id='name'
                                    type='text'
                                    autoComplete='name'
                                    maxLength={200}
                                    placeholder='John Doe'
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    required
                                />
                            </Field>
                            <Field>
                                <FieldLabel htmlFor='email'>
                                    {t('email')}
                                </FieldLabel>
                                <Input
                                    id='email'
                                    type='email'
                                    autoComplete='email'
                                    maxLength={254}
                                    placeholder='m@example.com'
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                />
                            </Field>
                            <Field>
                                <Field className='grid grid-cols-2 gap-4'>
                                    <Field>
                                        <FieldLabel htmlFor='password'>
                                            {t('password')}
                                        </FieldLabel>
                                        <Input
                                            id='password'
                                            type='password'
                                            autoComplete='new-password'
                                            value={password}
                                            onChange={(e) =>
                                                setPassword(e.target.value)
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
                                            autoComplete='new-password'
                                            value={confirmPassword}
                                            onChange={(e) =>
                                                setConfirmPassword(
                                                    e.target.value
                                                )
                                            }
                                            required
                                        />
                                    </Field>
                                </Field>
                                <FieldDescription>
                                    {t('passwordRequirement')}
                                </FieldDescription>
                            </Field>
                            <Field>
                                <Button
                                    type='submit'
                                    disabled={
                                        busy ||
                                        password !== confirmPassword ||
                                        password.length < 8
                                    }
                                >
                                    {busy
                                        ? t('creatingAccount')
                                        : t('createAccount')}
                                </Button>
                            </Field>
                            <FieldSeparator className='*:data-[slot=field-separator-content]:bg-card'>
                                {t('or')}
                            </FieldSeparator>

                            <FieldDescription className='text-center'>
                                {t('alreadyHaveAccount')}{' '}
                                <Link href={signInHref} prefetch={false}>
                                    {t('signIn')}
                                </Link>
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
