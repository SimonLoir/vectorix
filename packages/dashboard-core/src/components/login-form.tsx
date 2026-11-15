'use client';
import { cn } from '@repo/ui/utils';
import { Button } from '@repo/ui/button';
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldSeparator,
} from '@repo/ui/field';
import { Input } from '@repo/ui/input';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '../hooks/use-auth';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { TwoFactorChallenge } from './two-factor-challenge';
import Link from 'next/link';
import { emailOwnershipSignInReturn } from '../lib/email-ownership';

/** Renders login methods and optionally exposes the public signup link. */
export function LoginForm({
    className,
    allowAccountCreation = false,
    successRedirectPath = '/',
    ...props
}: React.ComponentProps<'div'> & {
    readonly allowAccountCreation?: boolean;
    readonly successRedirectPath?: string;
}) {
    const router = useRouter();
    const authClient = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [twoFactorPending, setTwoFactorPending] = useState(false);
    const [busy, setBusy] = useState(false);
    const t = useTranslations('login');
    const returnTo = emailOwnershipSignInReturn(successRedirectPath);
    const signUpHref =
        returnTo === '/dashboard'
            ? '/sign-up'
            : `/sign-up?${new URLSearchParams({ returnTo })}`;

    const completeSignIn = () => {
        toast.success(t('loginSuccessful'));
        void router.push(successRedirectPath);
    };

    return (
        <div className={cn('flex flex-col gap-6', className)} {...props}>
            {twoFactorPending ? (
                <TwoFactorChallenge
                    onVerified={completeSignIn}
                    onCancel={() => {
                        setTwoFactorPending(false);
                        setPassword('');
                    }}
                />
            ) : (
                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        setBusy(true);
                        try {
                            await authClient.signIn.email(
                                {
                                    email,
                                    password,
                                },
                                {
                                    onSuccess: (ctx) => {
                                        // A pending 2FA challenge has no session yet.
                                        if (
                                            typeof ctx.data === 'object' &&
                                            ctx.data !== null &&
                                            'twoFactorRedirect' in ctx.data &&
                                            ctx.data.twoFactorRedirect === true
                                        ) {
                                            setTwoFactorPending(true);
                                            return;
                                        }
                                        completeSignIn();
                                    },
                                    onError: () => {
                                        toast.error(t('loginFailed'));
                                    },
                                }
                            );
                        } catch {
                            toast.error(t('loginFailed'));
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    <FieldGroup>
                        <div className='flex flex-col gap-1.5'>
                            <h1 className='text-2xl font-semibold tracking-tight'>
                                {t('welcomeBack')}
                            </h1>
                            <p className='text-sm text-balance text-muted-foreground'>
                                {t('loginToAccount')}
                            </p>
                        </div>
                        <Field>
                            <FieldLabel htmlFor='email'>
                                {t('email')}
                            </FieldLabel>
                            <Input
                                id='email'
                                type='email'
                                autoComplete='email'
                                placeholder='m@example.com'
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                            />
                        </Field>
                        <Field>
                            <div className='flex items-center'>
                                <FieldLabel htmlFor='password'>
                                    {t('password')}
                                </FieldLabel>
                                <a
                                    href='/forgot-password'
                                    className='ml-auto text-sm underline-offset-2 hover:underline'
                                >
                                    {t('forgotPassword')}
                                </a>
                            </div>
                            <Input
                                id='password'
                                type='password'
                                autoComplete='current-password'
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                        </Field>
                        <Field>
                            <Button type='submit' disabled={busy}>
                                {busy ? t('signingIn') : t('login')}
                            </Button>
                        </Field>

                        <FieldSeparator className='*:data-[slot=field-separator-content]:bg-background'>
                            {t('or')}
                        </FieldSeparator>

                        <Field>
                            <Button
                                type='button'
                                variant='secondary'
                                disabled={busy}
                                onClick={async () => {
                                    setBusy(true);
                                    try {
                                        await authClient.signIn.passkey({
                                            fetchOptions: {
                                                onSuccess: () => {
                                                    void router.push(
                                                        successRedirectPath
                                                    );
                                                },
                                                onError: () => {
                                                    toast.error(
                                                        t('loginFailed')
                                                    );
                                                },
                                            },
                                        });
                                    } catch {
                                        toast.error(t('loginFailed'));
                                    } finally {
                                        setBusy(false);
                                    }
                                }}
                            >
                                {t('usePasskey')}
                            </Button>
                        </Field>

                        {allowAccountCreation && (
                            <FieldDescription className='text-center'>
                                {t('noAccount')}{' '}
                                <Link href={signUpHref} prefetch={false}>
                                    {t('signUp')}
                                </Link>
                            </FieldDescription>
                        )}
                    </FieldGroup>
                </form>
            )}
        </div>
    );
}
