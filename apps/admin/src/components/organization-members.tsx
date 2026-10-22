'use client';
import { useTranslations, useFormatter } from 'next-intl';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Mail, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
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
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@repo/ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@repo/ui/table';
import { useORPC } from '@/hooks/use-orpc';
import { AddOrganizationMemberDialog } from './add-organization-member-dialog';
import { LoadingState } from './loading-state';

type MemberRole = 'owner' | 'admin' | 'member';
type SelectedMember = {
    id: string;
    name: string;
    email: string;
    role: string;
};

function initials(name: string) {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();
}

export function OrganizationMembers({
    organizationId,
}: {
    readonly organizationId: string;
}) {
    const tr = useTranslations('admin.core');
    const format = useFormatter();
    const roleLabels: Record<string, string> = {
        owner: tr('owner'),
        admin: tr('administrator'),
        member: tr('member'),
    };
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const [memberToRemove, setMemberToRemove] = useState<SelectedMember | null>(
        null
    );
    const queryOptions = orpc.superadmin.organizations.get.queryOptions({
        input: { organizationId },
    });
    const query = useQuery(queryOptions);
    const updateRole = useMutation(
        orpc.superadmin.organizations.members.updateRole.mutationOptions({
            onSuccess: async () => {
                toast.success(tr('roleUpdated'));
                await queryClient.invalidateQueries(queryOptions);
            },
            onError: () => toast.error(tr('saveFailed')),
        })
    );
    const remove = useMutation(
        orpc.superadmin.organizations.members.remove.mutationOptions({
            onSuccess: async () => {
                toast.success(tr('memberRemoved'));
                setMemberToRemove(null);
                await queryClient.invalidateQueries(queryOptions);
            },
            onError: () => toast.error(tr('saveFailed')),
        })
    );

    if (query.isPending) return <LoadingState label={tr('membersLoading')} />;
    if (query.isError) {
        return <p className='text-sm text-destructive'>{tr('loadFailed')}</p>;
    }

    return (
        <>
            <Card className='admin-panel overflow-hidden rounded-2xl py-0 shadow-none'>
                <CardHeader className='flex flex-row items-center justify-between gap-4 border-b border-white/8 py-5'>
                    <div>
                        <CardTitle className='flex items-center gap-2'>
                            <span className='grid h-9 w-9 place-items-center rounded-xl bg-indigo-400/10 text-indigo-300'>
                                <Users className='h-4 w-4' />
                            </span>
                            {tr('organizationMembers')}
                        </CardTitle>
                        <p className='mt-1 text-sm text-muted-foreground'>
                            {tr('memberCount', {
                                count: query.data.members.length,
                            })}
                        </p>
                    </div>
                    <AddOrganizationMemberDialog
                        organizationId={organizationId}
                    />
                </CardHeader>
                <CardContent className='px-0'>
                    <div className='overflow-x-auto'>
                        <Table>
                            <TableHeader>
                                <TableRow className='border-white/8 bg-white/[0.025] hover:bg-white/[0.025]'>
                                    <TableHead className='h-12 pl-6 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                                        {tr('user')}
                                    </TableHead>
                                    <TableHead>{tr('status')}</TableHead>
                                    <TableHead>{tr('role')}</TableHead>
                                    <TableHead>{tr('addedOn')}</TableHead>
                                    <TableHead className='pr-6 text-right'>
                                        {tr('action')}
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {query.data.members.map((member) => (
                                    <TableRow
                                        key={member.id}
                                        className='border-white/8 hover:bg-cyan-400/[0.035]'
                                    >
                                        <TableCell className='py-4 pl-6'>
                                            <div className='flex min-w-56 items-center gap-3'>
                                                <Avatar className='h-9 w-9'>
                                                    <AvatarImage
                                                        src={
                                                            member.user.image ??
                                                            undefined
                                                        }
                                                    />
                                                    <AvatarFallback className='bg-indigo-400/10 text-xs font-semibold text-indigo-300'>
                                                        {initials(
                                                            member.user.name
                                                        )}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <div>
                                                    <p className='font-semibold text-slate-100'>
                                                        {member.user.name}
                                                    </p>
                                                    <p className='flex items-center gap-1 text-xs text-muted-foreground'>
                                                        <Mail className='h-3 w-3' />
                                                        {member.user.email}
                                                    </p>
                                                </div>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {member.user.emailVerified ? (
                                                <Badge
                                                    variant='outline'
                                                    className='border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                                                >
                                                    <CheckCircle2 />{' '}
                                                    {tr('verified')}
                                                </Badge>
                                            ) : (
                                                <Badge variant='secondary'>
                                                    {tr('unverified')}
                                                </Badge>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            <Select
                                                value={member.role}
                                                disabled={updateRole.isPending}
                                                onValueChange={(role) =>
                                                    updateRole.mutate({
                                                        organizationId,
                                                        memberId: member.id,
                                                        role: role as MemberRole,
                                                    })
                                                }
                                            >
                                                <SelectTrigger
                                                    aria-label={tr(
                                                        'organizationRole'
                                                    )}
                                                    className='h-9 w-40 rounded-xl border-white/10 bg-black/15 shadow-none'
                                                >
                                                    <SelectValue>
                                                        {roleLabels[
                                                            member.role
                                                        ] ?? member.role}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value='owner'>
                                                        {tr('owner')}
                                                    </SelectItem>
                                                    <SelectItem value='admin'>
                                                        {tr('administrator')}
                                                    </SelectItem>
                                                    <SelectItem value='member'>
                                                        {tr('member')}
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </TableCell>
                                        <TableCell className='whitespace-nowrap text-sm text-muted-foreground'>
                                            {format.dateTime(
                                                new Date(member.createdAt),
                                                { dateStyle: 'medium' }
                                            )}
                                        </TableCell>
                                        <TableCell className='pr-6 text-right'>
                                            <Button
                                                size='icon'
                                                variant='ghost'
                                                className='text-muted-foreground hover:text-destructive'
                                                title={tr('removeMember')}
                                                aria-label={tr('removeMember')}
                                                onClick={() =>
                                                    setMemberToRemove({
                                                        id: member.id,
                                                        name: member.user.name,
                                                        email: member.user
                                                            .email,
                                                        role: member.role,
                                                    })
                                                }
                                            >
                                                <Trash2 className='h-4 w-4' />
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                                {query.data.members.length === 0 ? (
                                    <TableRow>
                                        <TableCell
                                            colSpan={5}
                                            className='h-40 text-center text-muted-foreground'
                                        >
                                            {tr('noMembers')}
                                        </TableCell>
                                    </TableRow>
                                ) : null}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

            <AlertDialog
                open={Boolean(memberToRemove)}
                onOpenChange={(open) => {
                    if (!open) setMemberToRemove(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {tr('removeMemberTitle')}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {tr('removeMemberDescription', {
                                name: memberToRemove?.name ?? '',
                                email: memberToRemove?.email ?? '',
                            })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={remove.isPending}>
                            {tr('cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            disabled={remove.isPending || !memberToRemove}
                            onClick={() => {
                                if (!memberToRemove) return;
                                remove.mutate({
                                    organizationId,
                                    memberId: memberToRemove.id,
                                });
                            }}
                        >
                            {remove.isPending
                                ? 'Suppression…'
                                : tr('removeMember')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
