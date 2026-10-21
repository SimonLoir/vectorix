import { ORPCError } from '@orpc/server';

export const EXPECTED_ORGANIZATION_HEADER = 'Vectorix-Expected-Organization-Id';

/** A caller may pin its tenant, but this header never selects or changes it. */
export function requireExpectedOrganization(
    headers: Headers,
    organizationId: string
) {
    const expected = headers.get(EXPECTED_ORGANIZATION_HEADER);
    if (expected !== null && expected !== organizationId) {
        throw new ORPCError('CONFLICT', {
            message:
                'The active organization changed. Select the intended organization and run the command again.',
        });
    }
    return organizationId;
}

/** Resolve current membership only after pinning the authenticated tenant. */
export async function resolveExpectedOrganizationAccess<T>(
    headers: Headers,
    activeOrganizationId: string,
    userId: string,
    getMemberAccess: (
        organizationId: string,
        userId: string
    ) => Promise<T | null>
) {
    const organizationId = requireExpectedOrganization(
        headers,
        activeOrganizationId
    );
    const access = await getMemberAccess(organizationId, userId);
    if (!access) throw new ORPCError('UNAUTHORIZED');
    return { organizationId, access };
}
