import { oc } from '@orpc/contract';
import { z } from 'zod';

/** Replaces one displayed legacy feature selection atomically; absent grants remain disabled. */
export const setLegacyFeaturesV1Contract = oc
    .route({
        method: 'PUT',
        path: '/{organizationId}/legacy-features',
        description:
            'Choose the exact catalogue features granted to a legacy organization without external billing. Live superadmin session only, optimistic organization/catalogue/grants snapshot, atomic audit. Globally inactive features remain disabled.',
    })
    .input(
        z.strictObject({
            organizationId: z.string().trim().min(1).max(200),
            expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
            enabledFeatureIds: z
                .array(z.string().min(1).max(200))
                .max(1000)
                .refine(
                    (ids) => new Set(ids).size === ids.length,
                    'Feature IDs must be unique'
                ),
        })
    )
    .output(
        z.object({
            organizationId: z.string(),
            version: z.string(),
            enabledFeatureIds: z.array(z.string()),
        })
    );
