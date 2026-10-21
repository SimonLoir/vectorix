'use client';
import type { ReactNode } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@repo/ui/dialog';
import { Button } from '@repo/ui/button';
import { ActionError, useCatalogAction } from './catalog-action';

export function CatalogDialog({
    title,
    description,
    busy = false,
    onClose,
    children,
}: Readonly<{
    title: string;
    description: string;
    busy?: boolean;
    onClose: () => void;
    children: ReactNode;
}>) {
    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open && !busy) onClose();
            }}
        >
            <DialogContent
                className='sm:max-w-2xl'
                showCloseButton={!busy}
                onEscapeKeyDown={(event) => {
                    if (busy) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (busy) event.preventDefault();
                }}
            >
                <DialogHeader>
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
                    Annuler
                </Button>
                <Button
                    variant='destructive'
                    disabled={mutation.busy}
                    onClick={() => void mutation.run(action, onClose)}
                >
                    {mutation.busy ? 'En cours…' : 'Confirmer'}
                </Button>
            </div>
        </CatalogDialog>
    );
}
