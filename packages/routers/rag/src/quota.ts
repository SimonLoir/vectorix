import { ragV1 } from './v1-implementer';
import { ragActor } from './services/access';
import { quotaLimits, quotaUsage } from './services/quotas';
export const getQuota = ragV1.quota.handler(async ({ context }) => {
    const actor = await ragActor(
        context,
        context.db,
        { ragQuota: ['read'] },
        true
    );
    const [limits, usage] = await Promise.all([
        quotaLimits(context.db, actor.organizationId),
        quotaUsage(context.db, actor.organizationId),
    ]);
    return { limits, usage };
});
