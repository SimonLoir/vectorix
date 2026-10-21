import { AdminLoginForm } from '@/components/login-form';

export default function SignInPage() {
    return (
        <main className='relative flex min-h-screen items-center justify-center overflow-hidden bg-[#080e1c] p-4 sm:p-8'>
            <div className='pointer-events-none absolute left-1/2 top-[-20rem] h-[40rem] w-[40rem] -translate-x-1/2 rounded-full bg-indigo-500/15 blur-3xl' />
            <AdminLoginForm />
        </main>
    );
}
