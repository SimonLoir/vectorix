import { ResetPasswordForm } from '@repo/dashboard-core/components/reset-password-form';
import { AuthLayout } from '@/components/shell/auth-layout';

type ResetPasswordPageProps = Readonly<{
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

function getSearchParam(
    value: string | string[] | undefined
): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function ResetPasswordPage({
    searchParams,
}: ResetPasswordPageProps) {
    const params = await searchParams;

    return (
        <AuthLayout>
            <ResetPasswordForm
                token={getSearchParam(params.token)}
                resetError={getSearchParam(params.error)}
            />
        </AuthLayout>
    );
}
