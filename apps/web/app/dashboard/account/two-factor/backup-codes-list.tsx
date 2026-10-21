'use client';
import { Button } from '@repo/ui/button';
import { Copy, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

/**
 * Shows freshly generated backup codes. Better Auth stores them encrypted and
 * never returns them again, so the user must copy or download them now.
 */
export function BackupCodesList({
    codes,
}: {
    readonly codes: readonly string[];
}) {
    const t = useTranslations('account.twoFactor');
    const text = codes.join('\n');

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success(t('backupCodesCopied'));
        } catch {
            toast.error(t('backupCodesCopyFailed'));
        }
    };

    const download = () => {
        const url = URL.createObjectURL(
            new Blob([`${t('backupCodesFileHeader')}\n\n${text}\n`], {
                type: 'text/plain',
            })
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = 'vectorix-backup-codes.txt';
        link.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className='space-y-3'>
            <p className='text-sm text-muted-foreground'>
                {t('backupCodesHelp')}
            </p>
            <ul
                className='grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm'
                aria-label={t('backupCodesTitle')}
            >
                {codes.map((code) => (
                    <li key={code} className='text-center'>
                        {code}
                    </li>
                ))}
            </ul>
            <div className='flex flex-wrap gap-2'>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={copy}
                >
                    <Copy className='mr-2 h-4 w-4' />
                    {t('copyBackupCodes')}
                </Button>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={download}
                >
                    <Download className='mr-2 h-4 w-4' />
                    {t('downloadBackupCodes')}
                </Button>
            </div>
        </div>
    );
}
