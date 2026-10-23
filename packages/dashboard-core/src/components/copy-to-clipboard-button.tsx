'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { toast } from 'sonner';

/** Copy only after a user click; caller cancellation and button props stay authoritative. */
export const CopyToClipboardButton = (
    props: React.ComponentProps<typeof Button> & Readonly<{ copyText: string }>
) => {
    const { copyText, onClick, disabled, ...rest } = props;
    const t = useTranslations('clipboard');
    const [busy, setBusy] = useState(false);
    return (
        <Button
            type='button'
            aria-label={busy ? t('copying') : t('copy')}
            {...rest}
            disabled={busy ? true : disabled}
            aria-busy={busy || undefined}
            onClick={async (event) => {
                setBusy(true);
                try {
                    await onClick?.(event);
                    if (event.defaultPrevented) return;
                    await navigator.clipboard.writeText(copyText);
                    toast.success(t('copied'));
                } catch {
                    toast.error(t('failed'));
                } finally {
                    setBusy(false);
                }
            }}
        />
    );
};
