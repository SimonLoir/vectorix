import { oc } from '@orpc/contract';
import { z } from 'zod';
import { semanticQuotaValues, semanticQuotaView } from '../rag/semantic';

const reference = z.object({ organizationId: z.string().min(1) }).strict();

export const getSemanticQuotaContract = oc
    .route({
        method: 'GET',
        path: '/{organizationId}/semantic-quota',
        description:
            'Read semantic indexing capacity and observed work; platform administrators only',
    })
    .input(reference)
    .output(semanticQuotaView.extend({ overridden: z.boolean() }));

export const setSemanticQuotaContract = oc
    .route({
        method: 'PUT',
        path: '/{organizationId}/semantic-quota',
        description:
            'Set technical semantic indexing limits; platform administrators only',
    })
    .input(reference.extend({ limits: semanticQuotaValues }))
    .output(semanticQuotaValues);
