import { os } from '@orpc/server';
import type { PrismaClient } from '@repo/db';
import { authorized } from '../../authorized';
import {
    assertVectorixFeatureEnabled,
    assertVectorixFeaturesEnabled,
    assertAnyVectorixFeaturesEnabled,
} from './resolve';

const createFeatureMiddleware = (featureKey: string) =>
    os
        .$context<{ db: PrismaClient; organizationId: string }>()
        .middleware(async ({ context, next }) => {
            await assertVectorixFeatureEnabled(
                context.db,
                context.organizationId,
                featureKey
            );

            return next();
        });

/**
 * Builds an authorized oRPC procedure that rejects organizations without the
 * requested Vectorix entitlement. It can wrap an entire domain router.
 */
export const featureAuthorized = (featureKey: string) =>
    authorized.use(createFeatureMiddleware(featureKey));

const createFeaturesMiddleware = (featureKeys: readonly string[]) =>
    os
        .$context<{ db: PrismaClient; organizationId: string }>()
        .middleware(async ({ context, next }) => {
            await assertVectorixFeaturesEnabled(
                context.db,
                context.organizationId,
                featureKeys
            );

            return next();
        });

/** Builds an authorized procedure requiring every listed entitlement. */
export const featuresAuthorized = (featureKeys: readonly string[]) =>
    authorized.use(createFeaturesMiddleware(featureKeys));

/** Guards mixed-domain entrypoints while their handlers still filter each resource independently. */
export const anyFeaturesAuthorized = (featureKeys: readonly string[]) =>
    authorized.use(
        os
            .$context<{ db: PrismaClient; organizationId: string }>()
            .middleware(async ({ context, next }) => {
                await assertAnyVectorixFeaturesEnabled(
                    context.db,
                    context.organizationId,
                    featureKeys
                );
                return next();
            })
    );
