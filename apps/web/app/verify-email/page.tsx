import type { Metadata } from 'next';
import { createHash } from 'node:crypto';
import {
    emailOwnershipCallback,
    isEmailVerificationToken,
} from '@repo/dashboard-core/lib/email-ownership';
import { LanguageSwitcher } from '@/components/language-switcher';
import { VerifyEmail } from './verify-email';

export const metadata: Metadata = {
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
};

/** Parse mail-link parameters on the server; verification always needs a click. */
export default async function VerifyEmailPage({
    searchParams,
}: Readonly<{
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
    const params = await searchParams;
    const callback =
        params.returnTo === undefined
            ? '/dashboard/account'
            : emailOwnershipCallback(params.returnTo);
    const token =
        isEmailVerificationToken(params.token) && callback
            ? params.token
            : null;
    const linkIdentity = createHash('sha256')
        .update(token ?? '')
        .update('\0')
        .update(callback ?? '')
        .digest('hex');
    return (
        <main className='bg-muted flex min-h-svh flex-col items-center justify-center p-6 md:p-10'>
            <div className='absolute top-4 right-4'>
                <LanguageSwitcher />
            </div>
            <div className='w-full max-w-lg'>
                <VerifyEmail
                    key={linkIdentity}
                    token={token}
                    returnTo={callback ?? '/dashboard/account'}
                />
            </div>
        </main>
    );
}
