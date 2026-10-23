'use client';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import DashboardPage from '@/components/dashboard-page';
import PageDescription from '@repo/dashboard-core/components/page-description';
import PageTitle from '@repo/dashboard-core/components/page-title';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@repo/ui/table';
import { Spinner } from '@repo/ui/spinner';
import { Button } from '@repo/ui/button';
import InviteMember from './components/invite-member';
import MemberLine from './components/member-line';
import InvitationLine from './components/invitation-line';
import { Separator } from '@repo/ui/separator';
import { useTranslations } from 'next-intl';
import { BreadCrumbs } from '@repo/dashboard-core/components/app-page-context';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';

export function MembersManager({
    embedded = false,
}: Readonly<{ embedded?: boolean }>) {
    const authClient = useAuth();
    const {
        data: activeOrganization,
        isPending,
        error,
        refetch,
    } = authClient.useActiveOrganization();
    const { data: session, isPending: sessionPending } =
        authClient.useSession();
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const canReadMembers = canOperation('admin.members.get');
    const organizationId = session?.session.activeOrganizationId;
    const memberOptions = orpc.admin.members.get.queryOptions({
        input: undefined,
    });
    const memberDetails = useQuery({
        ...memberOptions,
        queryKey: [
            ...memberOptions.queryKey,
            session?.session.id,
            session?.user.id,
            organizationId,
        ],
        enabled: Boolean(
            session?.session.id &&
            session?.user.id &&
            organizationId &&
            activeOrganization?.id === organizationId &&
            canReadMembers
        ),
    });
    const t = useTranslations('members');
    const tBc = useTranslations('breadcrumbs');

    if (isPending || sessionPending)
        return (
            <div className='grid h-32 place-items-center'>
                <Spinner aria-label={t('loading')} />
            </div>
        );
    if (
        error ||
        !activeOrganization ||
        activeOrganization.id !== organizationId
    )
        return (
            <div className='space-y-3 p-6'>
                <p role='alert'>{t('loadFailed')}</p>
                <Button variant='outline' onClick={() => void refetch()}>
                    {t('reload')}
                </Button>
            </div>
        );

    const members = activeOrganization.members || [];
    const avatarColors = new Map(
        canReadMembers && activeOrganization.id === organizationId
            ? (memberDetails.data?.members.map(
                  (member) => [member.id, member.avatarColor] as const
              ) ?? [])
            : []
    );
    const invitations = (activeOrganization.invitations || []).filter(
        (i) => i.status === 'pending'
    );

    const Container = embedded ? 'div' : DashboardPage;
    return (
        <Container className='space-y-6'>
            {!embedded && (
                <>
                    {' '}
                    <BreadCrumbs
                        breadcrumbs={[
                            { title: tBc('dashboard'), url: '/dashboard' },
                            { title: tBc('organization') },
                            { title: tBc('members') },
                        ]}
                    />
                    <div>
                        <PageTitle>{t('title')}</PageTitle>
                        <PageDescription>{t('description')}</PageDescription>
                    </div>
                </>
            )}
            <div className='space-y-4'>
                <div>
                    <h3 className='text-lg font-medium mb-2'>
                        {t('membersSection')}
                    </h3>
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
                            {members.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={4}
                                        className='text-center text-muted-foreground'
                                    >
                                        {t('noMembers')}
                                    </TableCell>
                                </TableRow>
                            ) : (
                                members.map((member) => (
                                    <MemberLine
                                        key={member.id}
                                        member={member}
                                        avatarColor={avatarColors.get(
                                            member.id
                                        )}
                                    />
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>

                {invitations.length > 0 && (
                    <>
                        <Separator />
                        <div>
                            <h3 className='text-lg font-medium mb-2'>
                                {t('pendingInvitations')}
                            </h3>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('email')}</TableHead>
                                        <TableHead>{t('role')}</TableHead>
                                        <TableHead>{t('expires')}</TableHead>
                                        <TableHead className='text-center'>
                                            {t('actions')}
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {invitations.map((invitation) => (
                                        <InvitationLine
                                            key={invitation.id}
                                            invitation={invitation}
                                        />
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </>
                )}

                <div className='text-center p-6'>
                    <InviteMember />
                </div>
            </div>
        </Container>
    );
}
