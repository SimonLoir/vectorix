import type { Metadata } from 'next';
import { createHash } from 'node:crypto';
import {
    emailOwnershipCallback,
    isEmailVerificationToken,
} from '@repo/dashboard-core/lib/email-ownership';
import { AuthLayout } from '@/components/shell/auth-layout';
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
        <AuthLayout width='md' as='main'>
            <VerifyEmail
                key={linkIdentity}
                token={token}
                returnTo={callback ?? '/dashboard/account'}
            />
        </AuthLayout>
    );
}
