import { SignupForm } from '@repo/dashboard-core/components/signup-form';
import { LanguageSwitcher } from '@/components/language-switcher';
import { isAccountCreationAllowed } from '@repo/auth/account-creation';
import { redirect } from 'next/navigation';

export default function SignUpPage() {
    if (!isAccountCreationAllowed()) {
        redirect('/sign-in');
    }

    return (
        <div className='bg-muted flex min-h-svh flex-col items-center justify-center p-6 md:p-10'>
            <div className='absolute top-4 right-4'>
                <LanguageSwitcher />
            </div>
            <div className='w-full max-w-sm md:max-w-4xl'>
                <SignupForm />
            </div>
        </div>
    );
}
