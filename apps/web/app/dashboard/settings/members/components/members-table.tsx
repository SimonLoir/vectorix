'use client';

import type { ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import type { PersonAvatarColor } from '@repo/dashboard-core/components/person-avatar';
import { Spinner } from '@repo/ui/spinner';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@repo/ui/table';
import MemberLine from './member-line';

/** Render one bounded page, with explicit loading and empty states on every page. */
export function MembersTable({
    members,
    avatarColors,
    isPending,
    emptyMessage,
}: Readonly<{
    members: readonly ComponentProps<typeof MemberLine>['member'][];
    avatarColors: ReadonlyMap<string, PersonAvatarColor | null>;
    isPending: boolean;
    emptyMessage: 'noMatches' | 'emptyPage' | 'noMembers';
}>) {
    const t = useTranslations('members');
    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>{t('name')}</TableHead>
                    <TableHead>{t('email')}</TableHead>
                    <TableHead>{t('role')}</TableHead>
                    <TableHead className='text-center'>
                        {t('actions')}
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {isPending ? (
                    <TableRow>
                        <TableCell colSpan={4}>
                            <Spinner aria-label={t('loading')} />
                        </TableCell>
                    </TableRow>
                ) : members.length === 0 ? (
                    <TableRow>
                        <TableCell
                            colSpan={4}
                            className='text-center text-muted-foreground'
                        >
                            {t(emptyMessage)}
                        </TableCell>
                    </TableRow>
                ) : (
                    members.map((member) => (
                        <MemberLine
                            key={member.id}
                            member={member}
                            avatarColor={avatarColors.get(member.id)}
                        />
                    ))
                )}
            </TableBody>
        </Table>
    );
}
