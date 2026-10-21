import { ragV1 } from '../v1-implementer';
import { ragActor, requireCollection } from '../services/access';
import { principalCandidates } from '../services/principals';

export const listGrantCandidates = ragV1.collections.grantCandidates.handler(
    async ({ context, input }) => {
        const actor = await ragActor(
            context,
            context.db,
            { ragCollection: ['manageGrants'] },
            true
        );
        await requireCollection(context.db, actor, input.id, 'administer');
        return principalCandidates(context.db, actor.organizationId, input);
    }
);
