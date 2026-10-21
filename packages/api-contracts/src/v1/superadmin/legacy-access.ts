import { oc } from '@orpc/contract';
import { z } from 'zod';

export const setOrganizationLegacyAccessV1Contract = oc
    .route({
        method: 'PUT',
        path: '/{organizationId}/legacy-access',
        description:
            'Explicitly grant or revoke the external billing exemption for a legacy organization. Features require separate explicit grants. Superadmin session only, audited atomically. Does not change roles, API-key permissions or any remote subscription, invoice or payment.',
    })
    .input(
        z.strictObject({
            organizationId: z.string().trim().min(1).max(200),
            enabled: z.boolean(),
        })
    )
    .output(z.object({ id: z.string(), vectorixLegacyAccess: z.boolean() }));
