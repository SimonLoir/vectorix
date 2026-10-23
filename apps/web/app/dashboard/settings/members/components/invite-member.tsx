'use client';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@repo/ui/dialog';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { Button } from '@repo/ui/button';
import InviteMemberForm from './invite-member-form';
import { PermissionGate } from '@/components/permissions/permission-gate';

export default function InviteMember() {
    const t = useTranslations('members');
    const [open, setOpen] = React.useState(false);
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <PermissionGate permissions={{ invitation: ['create'] }}>
                <DialogTrigger asChild>
                    <Button>{t('inviteMember')}</Button>
                </DialogTrigger>
            </PermissionGate>
            <DialogContent
                className='max-h-[90dvh] overflow-y-auto'
                closeLabel={t('close')}
            >
                <DialogHeader>
                    <DialogTitle>{t('inviteMember')}</DialogTitle>
                    <DialogDescription>
                        {t('inviteDescription')}
                    </DialogDescription>
                </DialogHeader>
                <InviteMemberForm onSuccess={() => setOpen(false)} />
            </DialogContent>
        </Dialog>
    );
}
