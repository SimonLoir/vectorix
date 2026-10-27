import { implement } from '@orpc/server';
import { retrievalContract } from '@repo/api-contracts/v1/retrieval';
import type { AuthorizedContext } from '@routers/utils/authorized';
export const retrievalV1 =
    implement(retrievalContract).$context<AuthorizedContext>();
