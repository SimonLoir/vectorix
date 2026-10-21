import { OrganizationWorkspace } from '@/components/organization-workspace';

export default async function OrganizationPage({
    params,
}: {
    readonly params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return <OrganizationWorkspace organizationId={id} />;
}
