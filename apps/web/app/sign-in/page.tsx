import { LoginForm } from '@repo/dashboard-core/components/login-form';
import { AuthLayout } from '@/components/shell/auth-layout';
import { isAccountCreationAllowed } from '@repo/auth/account-creation';
import { emailOwnershipSignInReturn } from '@repo/dashboard-core/lib/email-ownership';
import type { Metadata } from 'next';

export const metadata: Metadata = {
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
};

export default async function LoginPage({
    searchParams,
}: Readonly<{
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
    const params = await searchParams;
    return (
        <AuthLayout>
            <LoginForm
                allowAccountCreation={isAccountCreationAllowed()}
                successRedirectPath={emailOwnershipSignInReturn(
                    params.returnTo
                )}
            />
        </AuthLayout>
    );
}
