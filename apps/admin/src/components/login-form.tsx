'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CheckCircle2, Orbit, ShieldCheck } from 'lucide-react';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';

/** Resolve a message key so pending and authentication errors stay reactive to locale changes. */
function submitMessageKey(pending: boolean, twoFactorPending: boolean) {
    if (twoFactorPending) return pending ? 'login.verifying' : 'login.verify';
    return pending ? 'login.signingIn' : 'login.signIn';
}

export function AdminLoginForm() {
    const t = useTranslations('admin.secondary');
    const auth = useAuth();
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<
        'login.invalidCode' | 'login.failed' | null
    >(null);
    const [pending, setPending] = useState(false);
    // Second step after `twoFactorRedirect`: TOTP or single-use backup code.
    const [twoFactorPending, setTwoFactorPending] = useState(false);
    const [useBackupCode, setUseBackupCode] = useState(false);
    const [code, setCode] = useState('');

    const finish = () => {
        router.replace('/');
        router.refresh();
    };

    const verifySecondFactor = async () => {
        const input = { code: code.trim() };
        const result = useBackupCode
            ? await auth.twoFactor.verifyBackupCode(input)
            : await auth.twoFactor.verifyTotp(input);
        setPending(false);
        if (result.error) {
            setError('login.invalidCode');
            return;
        }
        finish();
    };

    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setPending(true);
        setError(null);

        if (twoFactorPending) {
            await verifySecondFactor();
            return;
        }

        const result = await auth.signIn.email({ email, password });
        setPending(false);
        if (result.error) {
            setError('login.failed');
            return;
        }
        if (
            (result.data as { twoFactorRedirect?: boolean } | null)
                ?.twoFactorRedirect
        ) {
            setTwoFactorPending(true);
            return;
        }

        finish();
    };

    return (
        <div className='grid w-full max-w-5xl overflow-hidden rounded-[32px] border border-white/10 bg-[#0d1423] shadow-2xl shadow-black/40 lg:grid-cols-[1.05fr_0.95fr]'>
            <section className='relative hidden overflow-hidden bg-[#101a33] p-12 text-white lg:flex lg:flex-col'>
                <div className='pointer-events-none absolute -left-24 -top-28 h-80 w-80 rounded-full bg-indigo-500/25 blur-3xl' />
                <div className='pointer-events-none absolute -bottom-28 -right-24 h-72 w-72 rounded-full bg-sky-400/15 blur-3xl' />
                <div className='relative flex items-center gap-3'>
                    <span className='grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg'>
                        <Orbit className='h-5 w-5' />
                    </span>
                    <p className='font-semibold'>Vectorix</p>
                </div>
                <div className='relative my-auto py-16'>
                    <p className='text-sm font-medium text-indigo-300'>
                        {t('login.kicker')}
                    </p>
                    <h1 className='mt-4 max-w-md text-4xl font-semibold leading-[1.12] tracking-[-0.04em]'>
                        {t('login.title')}
                    </h1>
                    <p className='mt-5 max-w-md text-sm leading-6 text-slate-400'>
                        {t('login.description')}
                    </p>
                    <div className='mt-9 space-y-3'>
                        {[
                            t('login.benefitOrganizations'),
                            t('login.benefitAccess'),
                            t('login.benefitAudit'),
                        ].map((item) => (
                            <div
                                key={item}
                                className='flex items-center gap-3 text-sm text-slate-300'
                            >
                                <CheckCircle2 className='h-4 w-4 text-emerald-400' />
                                {item}
                            </div>
                        ))}
                    </div>
                </div>
                <p className='relative text-xs text-slate-600'>
                    {t('login.restricted')}
                </p>
            </section>
            <section className='flex items-center border-l border-white/8 bg-[#0d1423] px-6 py-10 sm:px-12 lg:px-14'>
                <div className='mx-auto w-full max-w-sm'>
                    <div className='mb-9'>
                        <span className='mb-6 grid h-11 w-11 place-items-center rounded-2xl bg-indigo-400/10 text-indigo-300 lg:hidden'>
                            <Orbit className='h-5 w-5' />
                        </span>
                        <div className='flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300'>
                            <ShieldCheck className='h-5 w-5' />
                        </div>
                        <h2 className='mt-5 text-3xl font-semibold tracking-[-0.04em] text-slate-100'>
                            {t('login.welcome')}
                        </h2>
                        <p className='mt-2 text-sm leading-6 text-slate-500'>
                            {t('login.instructions')}
                        </p>
                    </div>
                    <form className='space-y-5' onSubmit={submit}>
                        {twoFactorPending ? (
                            <div className='space-y-2'>
                                <Label
                                    htmlFor='two-factor-code'
                                    className='text-xs font-medium text-slate-300'
                                >
                                    {useBackupCode
                                        ? t('login.backupCode')
                                        : t('login.appCode')}
                                </Label>
                                <Input
                                    className='admin-field'
                                    id='two-factor-code'
                                    autoComplete='one-time-code'
                                    autoFocus
                                    inputMode={
                                        useBackupCode ? 'text' : 'numeric'
                                    }
                                    maxLength={useBackupCode ? 32 : 6}
                                    value={code}
                                    onChange={(event) =>
                                        setCode(event.target.value)
                                    }
                                    required
                                />
                                <button
                                    type='button'
                                    className='text-xs text-indigo-300 underline-offset-2 hover:underline'
                                    onClick={() => {
                                        setUseBackupCode(!useBackupCode);
                                        setCode('');
                                        setError(null);
                                    }}
                                >
                                    {useBackupCode
                                        ? t('login.useApp')
                                        : t('login.useBackup')}
                                </button>
                            </div>
                        ) : (
                            <>
                                <div className='space-y-2'>
                                    <Label
                                        htmlFor='email'
                                        className='text-xs font-medium text-slate-300'
                                    >
                                        {t('login.email')}
                                    </Label>
                                    <Input
                                        className='admin-field'
                                        id='email'
                                        type='email'
                                        autoComplete='email'
                                        value={email}
                                        onChange={(event) =>
                                            setEmail(event.target.value)
                                        }
                                        required
                                    />
                                </div>
                                <div className='space-y-2'>
                                    <Label
                                        htmlFor='password'
                                        className='text-xs font-medium text-slate-300'
                                    >
                                        {t('login.password')}
                                    </Label>
                                    <Input
                                        className='admin-field'
                                        id='password'
                                        type='password'
                                        autoComplete='current-password'
                                        value={password}
                                        onChange={(event) =>
                                            setPassword(event.target.value)
                                        }
                                        required
                                    />
                                </div>
                            </>
                        )}
                        {error ? (
                            <p className='rounded-xl border border-red-400/15 bg-red-400/8 px-4 py-3 text-sm text-red-300'>
                                {t(error)}
                            </p>
                        ) : null}
                        <Button
                            className='h-11 w-full rounded-xl shadow-lg shadow-indigo-200/50'
                            type='submit'
                            disabled={pending}
                        >
                            {t(submitMessageKey(pending, twoFactorPending))}
                            {pending ? null : (
                                <ArrowRight className='h-4 w-4' />
                            )}
                        </Button>
                    </form>
                    <p className='mt-7 text-center text-[11px] text-slate-400'>
                        {t('login.notice')}
                    </p>
                </div>
            </section>
        </div>
    );
}
