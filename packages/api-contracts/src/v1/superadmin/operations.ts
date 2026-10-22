import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id } from '../rag/common';
import { operationsSummary } from '../rag/operations';

export const getOperationsContract = oc
    .route({
        method: 'GET',
        path: '/{organizationId}/operations',
        description:
            'Read current organization work totals without document or collection details; platform administrators only',
    })
    .input(z.object({ organizationId: id }).strict())
    .output(operationsSummary);
