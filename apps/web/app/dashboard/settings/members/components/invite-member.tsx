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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('inviteMember')}</DialogTitle>
                    <DialogDescription>
                        {t('inviteDescription')}
                    </DialogDescription>
                    <InviteMemberForm onSuccess={() => setOpen(false)} />
                </DialogHeader>
            </DialogContent>
        </Dialog>
    );
}
