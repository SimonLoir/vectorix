import { ReactNode } from 'react';

export default function PageDescription({
    children,
}: Readonly<{ children: ReactNode }>) {
    return (
        <p className='mt-1 max-w-3xl text-pretty text-sm leading-relaxed text-muted-foreground sm:text-base'>
            {children}
        </p>
    );
}
