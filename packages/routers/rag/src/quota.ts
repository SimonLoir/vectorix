import { ragV1 } from './v1-implementer';
import { ragActor } from './services/access';
import { quotaLimits, quotaUsage } from './services/quotas';
import {
    semanticQuotaLimits,
    semanticQuotaUsage,
} from './services/semantic-quotas';
export const getQuota = ragV1.quota.handler(async ({ context }) => {
    const actor = await ragActor(
        context,
        context.db,
        { ragQuota: ['read'] },
        true
    );
    const [limits, usage, semanticLimits, semanticUsage] = await Promise.all([
        quotaLimits(context.db, actor.organizationId),
        quotaUsage(context.db, actor.organizationId),
        semanticQuotaLimits(context.db, actor.organizationId),
        semanticQuotaUsage(context.db, actor.organizationId),
    ]);
    return {
        limits,
        usage,
        semantic: { limits: semanticLimits, usage: semanticUsage },
    };
});
