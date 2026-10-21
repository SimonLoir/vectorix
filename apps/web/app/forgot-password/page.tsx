import { ForgotPasswordForm } from '@repo/dashboard-core/components/forgot-password-form';
import { LanguageSwitcher } from '@/components/language-switcher';

export default function ForgotPasswordPage() {
    return (
        <div className='bg-muted flex min-h-svh flex-col items-center justify-center p-6 md:p-10'>
            <div className='absolute top-4 right-4'>
                <LanguageSwitcher />
            </div>
            <div className='w-full max-w-sm md:max-w-4xl'>
                <ForgotPasswordForm />
            </div>
        </div>
    );
}
