'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import { Button } from '@repo/ui/button';
import type { SecurityErrorKey } from './security-errors';

/** Bounded modal confirmation keeps errors visible and cannot imply cancellation of an in-flight mutation. */
export function SecurityConfirmationDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    busy,
    error,
    onConfirm,
    returnFocus,
    children,
}: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    confirmLabel: string;
    busy: boolean;
    error: SecurityErrorKey | null;
    onConfirm: () => Promise<void>;
    returnFocus: () => void;
    children?: ReactNode;
}>) {
    const t = useTranslations('accountSecurity');
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!busy) onOpenChange(next);
            }}
        >
            <DialogContent
                closeLabel={t('close')}
                showCloseButton={!busy}
                onEscapeKeyDown={(event) => {
                    if (busy) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (busy) event.preventDefault();
                }}
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    returnFocus();
                }}
            >
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <form
                    className='space-y-4'
                    onSubmit={(event) => {
                        event.preventDefault();
                        void onConfirm();
                    }}
                >
                    {children}
                    {error && (
                        <p role='alert' className='text-destructive text-sm'>
                            {t(`errors.${error}`)}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            type='button'
                            variant='outline'
                            disabled={busy}
                            onClick={() => {
                                onOpenChange(false);
                            }}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type='submit'
                            variant='destructive'
                            disabled={busy}
                        >
                            {busy ? t('working') : confirmLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
