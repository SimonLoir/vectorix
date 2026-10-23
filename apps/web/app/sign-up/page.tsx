import { SignupForm } from '@repo/dashboard-core/components/signup-form';
import { LanguageSwitcher } from '@/components/language-switcher';
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
        <div className='bg-muted flex min-h-svh flex-col items-center justify-center p-6 md:p-10'>
            <div className='absolute top-4 right-4'>
                <LanguageSwitcher />
            </div>
            <div className='w-full max-w-sm md:max-w-4xl'>
                <SignupForm successRedirectPath={returnTo} />
            </div>
        </div>
    );
}
