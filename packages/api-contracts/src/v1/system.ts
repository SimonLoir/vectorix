import { oc } from '@orpc/contract';
import { z } from 'zod';

export const HealthInputV1Schema = z.object({}).strict().default({});
export const HealthOutputV1Schema = z.literal('ok');

export const systemV1Contract = {
    health: oc
        .route({
            path: '/health',
            method: 'GET',
            tags: ['System'],
            description: 'Check the health of the API',
        })
        .input(HealthInputV1Schema)
        .output(HealthOutputV1Schema),
};
