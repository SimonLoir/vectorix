import { isInvitationId } from '@repo/dashboard-core/lib/email-ownership';
import { InvitationReview } from './invitation-review';

export default async function AcceptInvitationPage({
    searchParams,
}: Readonly<{
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
    const params = await searchParams;
    return (
        <InvitationReview
            invitationId={isInvitationId(params.id) ? params.id : null}
        />
    );
}
