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
                'mx-auto w-full max-w-[1600px] flex-1 p-4 sm:p-6 [--editor-sticky-top:4rem] group-has-data-[collapsible=icon]/sidebar-wrapper:[--editor-sticky-top:3rem]',
                className
            )}
        >
            {children}
        </main>
    );
}
