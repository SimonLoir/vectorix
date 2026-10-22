'use client';
import { useTranslations } from 'next-intl';
import { LoaderCircle } from 'lucide-react';

export function LoadingState({ label }: { readonly label?: string }) {
    const tr = useTranslations('admin.core');
    return (
        <div
            role='status'
            className='flex min-h-48 items-center justify-center gap-3 text-sm text-muted-foreground'
        >
            <LoaderCircle className='h-5 w-5 animate-spin' />
            {label ?? tr('loading')}
        </div>
    );
}
