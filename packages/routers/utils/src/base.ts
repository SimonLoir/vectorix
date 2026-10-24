import { os } from '@orpc/server';
import { PrismaClient } from '@repo/db';
import { Logger } from 'pino';

export type ApiContext = {
    headers: Headers;
    /** Response headers collected by oRPC's ResponseHeadersPlugin (for example Retry-After). */
    resHeaders?: Headers;
    db: PrismaClient;
    logger: Logger;
};

export const base = os.$context<ApiContext>();
