import { z } from 'zod';
import type { SemanticChunkPlan } from '@repo/db';
import type { StructuredExtraction } from '@repo/documents';
import {
    SEMANTIC_CHUNKER_VERSION,
    SEMANTIC_UNITIZER_VERSION,
    SemanticStateError,
    quantizeSemanticVector,
    validateSemanticUnits,
    validateSemanticDistances,
    validateSemanticPlan,
    semanticThreshold,
    type SemanticOptions,
    type SemanticRange,
} from '@repo/chunking';

const ranges = z
    .array(
        z
            .object({
                ordinal: z.number().int().nonnegative(),
                start: z.number().int().nonnegative(),
                end: z.number().int().positive(),
            })
            .strict()
    )
    .max(100_000);
const scores = z.array(z.number().int().min(0).max(2_000_000)).max(8191);

export interface SemanticPlanContext {
    artifact: StructuredExtraction;
    options: SemanticOptions;
    sourceHash: string;
    profileHash: string;
    modelIdentity: string;
    dimensions: number;
    configurationRevision: number;
}

/** Canonical serialized protocol bytes, including the checkpoint; this is not PostgreSQL physical storage size. */
export function semanticPayloadBytes(
    plan: Pick<
        SemanticChunkPlan,
        | 'unitRanges'
        | 'boundaryScores'
        | 'finalRanges'
        | 'lastUnitVector'
        | 'chunkerVersion'
        | 'unitizerVersion'
        | 'sourceHash'
        | 'profileHash'
        | 'modelIdentity'
        | 'unitManifestHash'
        | 'planHash'
    >
) {
    return (
        Buffer.byteLength(
            JSON.stringify({
                unitRanges: plan.unitRanges,
                boundaryScores: plan.boundaryScores,
                finalRanges: plan.finalRanges,
                chunkerVersion: plan.chunkerVersion,
                unitizerVersion: plan.unitizerVersion,
                sourceHash: plan.sourceHash,
                profileHash: plan.profileHash,
                modelIdentity: plan.modelIdentity,
                unitManifestHash: plan.unitManifestHash,
                planHash: plan.planHash,
            }),
            'utf8'
        ) + (plan.lastUnitVector?.byteLength ?? 0)
    );
}

/** Float32 little-endian is explicit so checkpoint replay never depends on native endianness. */
export function encodeSemanticCheckpoint(vector: readonly number[]) {
    const normalized = quantizeSemanticVector(vector);
    const bytes = Buffer.alloc(normalized.length * 4);
    for (const [index, value] of normalized.entries())
        bytes.writeFloatLE(value, index * 4);
    return bytes;
}

/** Reject truncated, dimension-drifted, nonfinite and zero-norm persisted checkpoints before cost. */
export function decodeSemanticCheckpoint(
    bytes: Uint8Array | null,
    dimensions: number
) {
    if (!bytes || bytes.byteLength !== dimensions * 4)
        throw new SemanticStateError();
    const buffer = Buffer.from(bytes);
    return quantizeSemanticVector(
        Array.from({ length: dimensions }, (_, index) =>
            buffer.readFloatLE(index * 4)
        )
    );
}

/** Check immutable bindings and full deterministic geometry once per claim, before spending further work. */
export function readSemanticPlan(
    plan: SemanticChunkPlan,
    context: SemanticPlanContext
) {
    if (
        plan.state === 'CLEANED' ||
        plan.chunkerVersion !== SEMANTIC_CHUNKER_VERSION ||
        plan.unitizerVersion !== SEMANTIC_UNITIZER_VERSION ||
        plan.configurationRevision !== context.configurationRevision ||
        plan.sourceHash !== context.sourceHash ||
        plan.profileHash !== context.profileHash ||
        plan.modelIdentity !== context.modelIdentity
    )
        throw new SemanticStateError();
    const parsedUnits = ranges.safeParse(plan.unitRanges),
        parsedScores = scores.safeParse(plan.boundaryScores);
    if (!parsedUnits.success || !parsedScores.success)
        throw new SemanticStateError();
    const units = parsedUnits.data,
        distances = parsedScores.data;
    validateSemanticUnits(
        context.artifact,
        units,
        plan.unitManifestHash,
        context.options
    );
    if (
        units.length !== plan.unitCount ||
        !Number.isSafeInteger(plan.completedUnits) ||
        plan.completedUnits < 0 ||
        plan.completedUnits > units.length ||
        plan.storedBytes !== BigInt(semanticPayloadBytes(plan))
    )
        throw new SemanticStateError();
    validateSemanticDistances(distances, plan.completedUnits);
    if (plan.state === 'READY') {
        const finalRanges = ranges.safeParse(plan.finalRanges);
        if (
            plan.completedUnits !== units.length ||
            plan.lastUnitVector !== null ||
            plan.reservedBytes !== 0n ||
            !plan.sealedAt ||
            !plan.planHash ||
            !finalRanges.success ||
            plan.thresholdDistance !==
                semanticThreshold(distances, context.options.semanticPercentile)
        )
            throw new SemanticStateError();
        validateSemanticPlan(
            context.artifact,
            context.options,
            { units, distances, unitManifestHash: plan.unitManifestHash },
            finalRanges.data,
            plan.planHash
        );
    } else if (
        plan.finalRanges !== null ||
        plan.planHash !== null ||
        plan.sealedAt !== null ||
        plan.thresholdDistance !== null ||
        (plan.completedUnits === 0
            ? plan.lastUnitVector !== null
            : !plan.lastUnitVector)
    )
        throw new SemanticStateError();
    else if (plan.lastUnitVector)
        decodeSemanticCheckpoint(plan.lastUnitVector, context.dimensions);
    return { units, distances, unitManifestHash: plan.unitManifestHash };
}

/** Validate canonical range storage without accepting extra keys or relying on JSON casts. */
export function semanticRanges(value: unknown): SemanticRange[] {
    const parsed = ranges.safeParse(value);
    if (!parsed.success) throw new SemanticStateError();
    return parsed.data;
}
