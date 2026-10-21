import { implement } from '@orpc/server';
import { systemV1Contract } from '@repo/api-contracts/v1/system';
import type { ApiContext } from '@routers/utils/base';

const systemV1 = implement(systemV1Contract).$context<ApiContext>();

export const healthV1 = systemV1.health.handler(() => 'ok');

export const systemV1Router = systemV1.router({
    health: healthV1,
});
