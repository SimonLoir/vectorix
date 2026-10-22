'use client';
import { useTranslations } from 'next-intl';
/** Translate headings on the client so language changes update an already-open page. */
export function PageHeader({
    title,
    description,
    titleKey,
    descriptionKey,
    action,
}: Readonly<{
    title?: string;
    description?: string;
    titleKey?: string;
    descriptionKey?: string;
    action?: React.ReactNode;
}>) {
    const tr = useTranslations('admin');
    return (
        <div className='flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between'>
            <div>
                <h1 className='text-3xl font-semibold tracking-[-0.035em] text-slate-100 sm:text-4xl'>
                    {titleKey ? tr(titleKey) : title}
                </h1>
                <p className='mt-2 max-w-3xl text-sm leading-6 text-slate-400'>
                    {descriptionKey ? tr(descriptionKey) : description}
                </p>
            </div>
            {action}
        </div>
    );
}
