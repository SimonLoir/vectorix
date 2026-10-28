'use client';
import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { CopyToClipboardButton } from '@repo/dashboard-core/components/copy-to-clipboard-button';

/** Copy only a user-selected template; snippets never contain an issued API key. */
export function ClientCode({
    title,
    code,
    disabled,
}: Readonly<{
    title: string;
    code: string;
    disabled: boolean;
}>) {
    const tr = useTranslations('rag.clients');
    return (
        <section className='min-w-0 space-y-3'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
                <h3 className='font-medium'>{title}</h3>
                <CopyToClipboardButton
                    copyText={code}
                    disabled={disabled}
                    variant='outline'
                    size='sm'
                    aria-label={tr('copyFor', { name: title })}
                >
                    <Copy aria-hidden className='size-4' />
                    {tr('copy')}
                </CopyToClipboardButton>
            </div>
            <pre
                tabIndex={0}
                aria-label={title}
                className='max-h-96 overflow-auto overscroll-contain rounded-lg bg-muted p-4 text-xs leading-relaxed'
            >
                <code>{code}</code>
            </pre>
        </section>
    );
}
