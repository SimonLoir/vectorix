import { commercialFeatureWhere } from '@routers/utils/vectorix-features';
import { superAdminV1 } from './v1-implementer';

export const listFeatureDefinitions = superAdminV1.features.list.handler(
    async ({ context: { db } }) => {
        const features = await db.vectorixFeatureDefinition.findMany({
            where: commercialFeatureWhere,
            include: {
                _count: { select: { organizationOverrides: true } },
            },
            orderBy: [{ category: 'asc' }, { name: 'asc' }],
        });

        return { features };
    }
);
