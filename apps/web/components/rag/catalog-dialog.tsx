'use client';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@repo/ui/dialog';
import { Button } from '@repo/ui/button';
import { cn } from '@repo/ui/utils';
import { ActionError, useCatalogAction } from './catalog-action';

export function CatalogDialog({
    title,
    description,
    busy = false,
    onClose,
    children,
    framed = false,
}: Readonly<{
    title: string;
    description: string;
    busy?: boolean;
    onClose: () => void;
    children: ReactNode;
    framed?: boolean;
}>) {
    const tr = useTranslations('rag');
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !busy) onClose();
            }}
        >
            <DialogContent
                className={cn(
                    'sm:max-w-2xl',
                    framed &&
                        'flex flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl'
                )}
                showCloseButton={!busy}
                closeLabel={tr('common.close')}
                onEscapeKeyDown={(event) => {
                    if (busy) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (busy) event.preventDefault();
                }}
            >
                <DialogHeader
                    className={
                        framed
                            ? 'shrink-0 border-b bg-info/5 px-6 py-5 pr-12 text-left'
                            : undefined
                    }
                >
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                {children}
            </DialogContent>
        </Dialog>
    );
}
export function ConfirmCatalogAction({
    title,
    description,
    action,
    onClose,
}: Readonly<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const mutation = useCatalogAction();
    return (
        <CatalogDialog
            title={title}
            description={description}
            busy={mutation.busy}
            onClose={onClose}
        >
            <ActionError error={mutation.error} />
            <div className='flex justify-end gap-2'>
                <Button
                    variant='outline'
                    disabled={mutation.busy}
                    onClick={onClose}
                >
                    {tr('common.cancel')}
                </Button>
                <Button
                    variant='destructive'
                    disabled={mutation.busy}
                    onClick={() => void mutation.run(action, onClose)}
                >
                    {mutation.busy
                        ? tr('common.working')
                        : tr('common.confirm')}
                </Button>
            </div>
        </CatalogDialog>
    );
}
