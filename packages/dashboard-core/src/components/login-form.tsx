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
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '../hooks/use-auth';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { TwoFactorChallenge } from './two-factor-challenge';

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
    const t = useTranslations('login');

    const completeSignIn = () => {
        toast.success(t('loginSuccessful'));
        void router.push(successRedirectPath);
    };

    return (
        <div className={cn('flex flex-col gap-6', className)} {...props}>
            <Card className='overflow-hidden p-0'>
                <CardContent className='grid p-0 md:grid-cols-2'>
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
                            className='p-6 md:p-8'
                            onSubmit={async (e) => {
                                e.preventDefault();
                                await authClient.signIn.email(
                                    {
                                        email,
                                        password,
                                    },
                                    {
                                        onSuccess: (ctx) => {
                                            // A pending 2FA challenge has no session yet.
                                            if (
                                                (
                                                    ctx.data as {
                                                        twoFactorRedirect?: boolean;
                                                    } | null
                                                )?.twoFactorRedirect
                                            ) {
                                                setTwoFactorPending(true);
                                                return;
                                            }
                                            completeSignIn();
                                        },
                                        onError: (ctx) => {
                                            // display the error message
                                            alert(ctx.error.message);
                                        },
                                    }
                                );
                            }}
                        >
                            <FieldGroup>
                                <div className='flex flex-col items-center gap-2 text-center'>
                                    <h1 className='text-2xl font-bold'>
                                        {t('welcomeBack')}
                                    </h1>
                                    <p className='text-muted-foreground text-balance'>
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
                                        placeholder='m@example.com'
                                        value={email}
                                        onChange={(e) =>
                                            setEmail(e.target.value)
                                        }
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
                                        value={password}
                                        onChange={(e) =>
                                            setPassword(e.target.value)
                                        }
                                        required
                                    />
                                </Field>
                                <Field>
                                    <Button type='submit'>{t('login')}</Button>
                                </Field>

                                <FieldSeparator className='*:data-[slot=field-separator-content]:bg-card'>
                                    {t('or')}
                                </FieldSeparator>

                                <Field>
                                    <Button
                                        type='button'
                                        variant='secondary'
                                        onClick={async () => {
                                            await authClient.signIn.passkey({
                                                fetchOptions: {
                                                    onSuccess: () => {
                                                        void router.push(
                                                            successRedirectPath
                                                        );
                                                    },
                                                },
                                            });
                                        }}
                                    >
                                        {t('usePasskey')}
                                    </Button>
                                </Field>

                                {allowAccountCreation && (
                                    <FieldDescription className='text-center'>
                                        {t('noAccount')}{' '}
                                        <a href='/sign-up'>{t('signUp')}</a>
                                    </FieldDescription>
                                )}
                            </FieldGroup>
                        </form>
                    )}
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
