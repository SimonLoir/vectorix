'use client';

import { TableCell, TableRow } from '@repo/ui/table';
import {
    Button,
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/permissions/actions';
import { useState, useSyncExternalStore } from 'react';
import { CopyIcon, XIcon } from 'lucide-react';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { toast } from 'sonner';
import { CopyToClipboardButton } from '@repo/dashboard-core/components/copy-to-clipboard-button';
import { invitationReviewPath } from '@repo/dashboard-core/lib/email-ownership';
import { useTranslations } from 'next-intl';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { InvitationExpiry } from './invitation-expiry';
import { memberActionError } from './member-errors';
import { useMemberRoleLabel } from './member-role-label';

type Invitation = {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
};

// The document origin is stable until full navigation. The server snapshot keeps
// hydration deterministic without reading a browser global during server render.
const subscribeToOrigin = () => () => {
    // No subscription to release: changing the origin requires a full navigation.
};
const browserOrigin = () => globalThis.location.origin;
const serverOrigin = () => '';

export default function InvitationLine({
    invitation,
}: {
    readonly invitation: Invitation;
}) {
    const authClient = useAuth();
    const t = useTranslations('members');
    const roleLabel = useMemberRoleLabel();
    const { can } = useVectorixPermissions();
    const [showCancelModal, setShowCancelModal] = useState(false);
    const [isCanceling, setIsCanceling] = useState(false);
    const invitationPath = invitationReviewPath(invitation.id);
    const origin = useSyncExternalStore(
        subscribeToOrigin,
        browserOrigin,
        serverOrigin
    );
    const invitationLink =
        invitationPath && origin ? new URL(invitationPath, origin).href : '';

    const handleCancelInvitation = async () => {
        if (!can({ invitation: ['cancel'] })) {
            toast.error(t('errors.permission'));
            return;
        }
        setIsCanceling(true);
        try {
            const { error } = await authClient.organization.cancelInvitation({
                invitationId: invitation.id,
            });

            if (error) {
                toast.error(t(`errors.${memberActionError(error)}`));
            } else {
                toast.success(t('invitationRevoked'));
                setShowCancelModal(false);
            }
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            setIsCanceling(false);
        }
    };

    return (
        <>
            <TableRow aria-busy={isCanceling}>
                <TableCell>{invitation.email}</TableCell>
                <TableCell>{roleLabel(invitation.role)}</TableCell>
                <TableCell className='text-muted-foreground text-sm'>
                    <InvitationExpiry expiresAt={invitation.expiresAt} />
                </TableCell>
                <TableCell className='text-center'>
                    <CopyToClipboardButton
                        variant='ghost'
                        size='icon'
                        copyText={invitationLink}
                        disabled={!invitationLink}
                        title={t('copyInvitationLink')}
                        aria-label={t('copyInvitationLinkFor', {
                            email: invitation.email,
                        })}
                    >
                        <CopyIcon aria-hidden='true' className='h-4 w-4' />
                    </CopyToClipboardButton>
                    <Button
                        permissions={{ invitation: ['cancel'] }}
                        variant='ghost'
                        size='icon'
                        onClick={() => setShowCancelModal(true)}
                        title={t('revokeInvitation')}
                        aria-label={t('revokeInvitationFor', {
                            email: invitation.email,
                        })}
                        disabled={isCanceling}
                    >
                        <XIcon aria-hidden='true' className='h-4 w-4' />
                    </Button>
                </TableCell>
            </TableRow>

            <AlertDialog
                open={showCancelModal}
                onOpenChange={setShowCancelModal}
            >
                <AlertDialogContent className='max-h-[90dvh] overflow-y-auto'>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {t('revokeInvitation')}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('revokeDescription', {
                                email: invitation.email,
                            })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isCanceling}>
                            {t('keepInvitation')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            permissions={{ invitation: ['cancel'] }}
                            onClick={handleCancelInvitation}
                            disabled={isCanceling}
                        >
                            {t(isCanceling ? 'revoking' : 'revokeInvitation')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
