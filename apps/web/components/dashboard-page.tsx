import { ReactNode } from 'react';
import { cn } from '@repo/ui/utils';

export default function DashboardPage({
    children,
    className,
}: Readonly<{
    children: ReactNode;
    className?: string;
}>) {
    return (
        <main
            data-vectorix-page
            className={cn(
                'mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
                className
            )}
        >
            {children}
        </main>
    );
}
