'use client';

import { TableCell, TableRow } from '@repo/ui/table';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    Button,
} from '@/components/permissions/actions';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@repo/ui/select';
import { useState } from 'react';
import { TrashIcon } from 'lucide-react';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import {
    PersonAvatar,
    type PersonAvatarColor,
} from '@repo/dashboard-core/components/person-avatar';
import { toast } from 'sonner';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { useTranslations } from 'next-intl';
import { memberActionError } from './member-errors';
import { useMemberRoleLabel } from './member-role-label';

type Member = {
    id: string;
    userId: string;
    role: string;
    user: {
        id: string;
        name: string;
        email: string;
        image?: string;
    };
};

export default function MemberLine({
    member,
    avatarColor,
}: {
    readonly member: Member;
    readonly avatarColor?: PersonAvatarColor | null;
}) {
    const authClient = useAuth();
    const t = useTranslations('members');
    const roleLabel = useMemberRoleLabel();
    const { access, can, refresh } = useVectorixPermissions();
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [isUpdating, setIsUpdating] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const { data: session } = authClient.useSession();
    const isCurrentUser = session?.user.id === member.userId;

    const handleRoleChange = async (newRole: string) => {
        if (isCurrentUser || !can({ member: ['update'] })) {
            toast.error(t('errors.permission'));
            return;
        }
        setIsUpdating(true);
        try {
            const { error } = await authClient.organization.updateMemberRole({
                memberId: member.id,
                role: newRole,
            });

            if (error) {
                toast.error(t(`errors.${memberActionError(error)}`));
            } else {
                toast.success(t('roleUpdated'));
                await refresh();
            }
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            setIsUpdating(false);
        }
    };

    const handleRemoveMember = async () => {
        if (isCurrentUser || !can({ member: ['delete'] })) {
            toast.error(t('errors.permission'));
            return;
        }
        setIsDeleting(true);
        try {
            const { error } = await authClient.organization.removeMember({
                memberIdOrEmail: member.id,
            });

            if (error) {
                toast.error(t(`errors.${memberActionError(error)}`));
            } else {
                toast.success(t('memberRemoved'));
                setShowDeleteModal(false);
                // Native auth refreshes its own store; refresh every RPC page/search too.
                await refresh();
            }
        } catch {
            toast.error(t('errors.generic'));
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <>
            <TableRow aria-busy={isUpdating || isDeleting}>
                <TableCell>
                    <div className='flex items-center gap-3'>
                        <PersonAvatar
                            name={member.user.name}
                            image={member.user.image}
                            color={avatarColor}
                            decorative
                        />
                        <span className='font-medium break-words'>
                            {member.user.name}
                            {isCurrentUser && (
                                <span className='text-muted-foreground'>
                                    {' '}
                                    {t('you')}
                                </span>
                            )}
                        </span>
                    </div>
                </TableCell>
                <TableCell>{member.user.email}</TableCell>
                <TableCell>
                    <Select
                        value={member.role}
                        onValueChange={handleRoleChange}
                        disabled={
                            isCurrentUser ||
                            isUpdating ||
                            !can({ member: ['update'] })
                        }
                    >
                        <SelectTrigger
                            className='w-[160px]'
                            aria-label={t('changeRoleFor', {
                                name: member.user.name,
                            })}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {access?.roles
                                .filter(
                                    (role) =>
                                        role.assignable ||
                                        role.role === member.role
                                )
                                .map((role) => (
                                    <SelectItem
                                        key={role.role}
                                        value={role.role}
                                        disabled={!role.assignable}
                                    >
                                        {roleLabel(role.role)}
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                </TableCell>
                <TableCell className='text-center flex justify-center gap-2'>
                    <Button
                        permissions={{ member: ['delete'] }}
                        variant='ghost'
                        size='icon'
                        onClick={() => setShowDeleteModal(true)}
                        disabled={isCurrentUser || isDeleting}
                        title={t('removeMemberFor', { name: member.user.name })}
                        aria-label={t('removeMemberFor', {
                            name: member.user.name,
                        })}
                    >
                        <TrashIcon aria-hidden='true' className='h-4 w-4' />
                    </Button>
                </TableCell>
            </TableRow>

            <AlertDialog
                open={showDeleteModal}
                onOpenChange={setShowDeleteModal}
            >
                <AlertDialogContent className='max-h-[90dvh] overflow-y-auto'>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t('removeMember')}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('removeDescription', { name: member.user.name })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDeleting}>
                            {t('keepMember')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            permissions={{ member: ['delete'] }}
                            onClick={handleRemoveMember}
                            disabled={isDeleting || isCurrentUser}
                        >
                            {t(isDeleting ? 'removing' : 'remove')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
