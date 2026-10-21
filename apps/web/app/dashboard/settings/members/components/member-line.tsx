import { TableCell, TableRow } from '@repo/ui/table';
import { Button } from '@repo/ui/button';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@repo/ui/alert-dialog';
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
    const { access, can, refresh } = useVectorixPermissions();
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [isUpdating, setIsUpdating] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const { data: session } = authClient.useSession();
    const isCurrentUser = session?.user.id === member.userId;

    const handleRoleChange = async (newRole: string) => {
        setIsUpdating(true);
        try {
            const { error } = await authClient.organization.updateMemberRole({
                memberId: member.id,
                role: newRole,
            });

            if (error) {
                toast.error(error.message ?? 'Failed to update member role');
            } else {
                toast.success('Member role updated successfully');
                await refresh();
            }
        } catch {
            toast.error('Failed to update member role');
        } finally {
            setIsUpdating(false);
        }
    };

    const handleRemoveMember = async () => {
        setIsDeleting(true);
        try {
            const { error } = await authClient.organization.removeMember({
                memberIdOrEmail: member.id,
            });

            if (error) {
                toast.error(error.message ?? 'Failed to remove member');
            } else {
                toast.success('Member removed successfully');
                setShowDeleteModal(false);
            }
        } catch {
            toast.error('Failed to remove member');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <>
            <TableRow>
                <TableCell>
                    <div className='flex items-center gap-3'>
                        <PersonAvatar
                            name={member.user.name}
                            image={member.user.image}
                            color={avatarColor}
                            decorative
                        />
                        <span className='font-medium'>{member.user.name}</span>
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
                        <SelectTrigger className='w-[120px]'>
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
                                        {role.role}
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                </TableCell>
                <TableCell className='text-center flex justify-center gap-2'>
                    <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => setShowDeleteModal(true)}
                        disabled={isCurrentUser || !can({ member: ['delete'] })}
                    >
                        <TrashIcon className='h-4 w-4' />
                    </Button>
                </TableCell>
            </TableRow>

            <AlertDialog
                open={showDeleteModal}
                onOpenChange={setShowDeleteModal}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove Member</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to remove {member.user.name}{' '}
                            from this organization? This action cannot be
                            undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDeleting}>
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleRemoveMember}
                            disabled={isDeleting}
                        >
                            {isDeleting ? 'Removing...' : 'Remove'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
