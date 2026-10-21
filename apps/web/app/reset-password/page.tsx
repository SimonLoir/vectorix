import { ResetPasswordForm } from '@repo/dashboard-core/components/reset-password-form';
import { LanguageSwitcher } from '@/components/language-switcher';

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
        <div className='bg-muted flex min-h-svh flex-col items-center justify-center p-6 md:p-10'>
            <div className='absolute top-4 right-4'>
                <LanguageSwitcher />
            </div>
            <div className='w-full max-w-sm md:max-w-4xl'>
                <ResetPasswordForm
                    token={getSearchParam(params.token)}
                    resetError={getSearchParam(params.error)}
                />
            </div>
        </div>
    );
}
