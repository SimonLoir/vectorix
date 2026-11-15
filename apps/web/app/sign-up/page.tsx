import { SignupForm } from '@repo/dashboard-core/components/signup-form';
import { AuthLayout } from '@/components/shell/auth-layout';
import { isAccountCreationAllowed } from '@repo/auth/account-creation';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { emailOwnershipSignInReturn } from '@repo/dashboard-core/lib/email-ownership';

export const metadata: Metadata = {
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
};

export default async function SignUpPage({
    searchParams,
}: Readonly<{
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
    const params = await searchParams;
    const returnTo = emailOwnershipSignInReturn(params.returnTo);
    if (!isAccountCreationAllowed()) {
        redirect(`/sign-in?${new URLSearchParams({ returnTo })}`);
    }

    return (
        <AuthLayout>
            <SignupForm successRedirectPath={returnTo} />
        </AuthLayout>
    );
}
