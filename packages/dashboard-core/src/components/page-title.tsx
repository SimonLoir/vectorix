import { ReactNode } from 'react';

export default function PageTitle({
    children,
}: Readonly<{ children: ReactNode }>) {
    return (
        <h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
            {children}
        </h1>
    );
}
