import { implement } from '@orpc/server';
import { ragContract } from '@repo/api-contracts/v1/rag/index';
import type { AuthorizedContext } from '@routers/utils/authorized';
export const ragV1 = implement(ragContract).$context<AuthorizedContext>();
