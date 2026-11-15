import { ForgotPasswordForm } from '@repo/dashboard-core/components/forgot-password-form';
import { AuthLayout } from '@/components/shell/auth-layout';

export default function ForgotPasswordPage() {
    return (
        <AuthLayout>
            <ForgotPasswordForm />
        </AuthLayout>
    );
}
