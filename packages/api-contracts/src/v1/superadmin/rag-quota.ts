import { oc } from '@orpc/contract';
import { z } from 'zod';
import { quotaValues } from '../rag/index';
export const setRagQuotaContract = oc
    .route({
        method: 'PUT',
        path: '/{organizationId}/rag-quota',
        description:
            'Set organization RAG quotas; platform administrators only',
    })
    .input(
        z
            .object({ organizationId: z.string().min(1), limits: quotaValues })
            .strict()
    )
    .output(quotaValues);
