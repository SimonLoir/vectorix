import { UserWorkspace } from '@/components/user-workspace';

export default async function UserPage({
    params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
    const { id } = await params;
    return <UserWorkspace key={id} userId={id} />;
}
