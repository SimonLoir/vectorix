import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import {
    getRecommendedEmbeddingDefaults,
    getReviewedEmbeddingProfile,
    supportsReviewedEmbeddingDimensions,
} from '@repo/embeddings/profiles';
import type { z } from 'zod';

type Profile = z.output<typeof collectionProfile>;
export type Provider = Profile['provider'];
export type MetadataRow = {
    id: number;
    key: string;
    type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'DATE';
};
export type ProfileDraft = {
    provider: Provider;
    model: string;
    dimensions: string;
    indexType: Profile['indexType'];
    embeddingPreset: Profile['embeddingPreset'];
    preparation: string;
    chunkingStrategy: Profile['chunkingStrategy'];
    parentChild: boolean;
    targetTokens: string;
    overlapTokens: string;
    minTokens: string;
    maxTokens: string;
    semanticPercentile: string;
    parentMaxTokens: string;
    metadataRows: MetadataRow[];
};

/** UI state survives section changes; only explicit reset replaces a saved profile. */
export function createProfileDraft(configuration?: Profile): ProfileDraft {
    const defaults = getRecommendedEmbeddingDefaults(
        'OLLAMA',
        'embeddinggemma'
    );
    return {
        provider: configuration?.provider ?? 'OLLAMA',
        model: configuration?.model ?? 'embeddinggemma',
        dimensions: String(
            configuration?.dimensions ?? defaults?.dimensions ?? 768
        ),
        indexType: configuration?.indexType ?? 'DISKANN',
        embeddingPreset:
            configuration?.embeddingPreset ??
            defaults?.embeddingPreset ??
            'EMBEDDING_GEMMA',
        preparation: configuration?.preparation ?? '',
        chunkingStrategy:
            configuration?.chunkingStrategy ?? 'DOCUMENT_STRUCTURE',
        parentChild: configuration?.parentChild ?? false,
        targetTokens: String(configuration?.chunking.targetTokens ?? 512),
        overlapTokens: String(configuration?.chunking.overlapTokens ?? 64),
        minTokens: String(configuration?.chunking.minTokens ?? 128),
        maxTokens: String(configuration?.chunking.maxTokens ?? 768),
        semanticPercentile: String(
            configuration?.chunking.semanticPercentile ?? 90
        ),
        parentMaxTokens: String(
            configuration?.chunking.parentMaxTokens ?? 2048
        ),
        metadataRows: Object.entries(configuration?.metadataFields ?? {}).map(
            ([key, type], id) => ({ id, key, type })
        ),
    };
}

/** The review must match a newly locked save while retaining the user's unsaved draft. */
export function effectiveProfileDraft(
    draft: ProfileDraft,
    saved: Profile | undefined,
    locked: boolean
): ProfileDraft {
    return locked && saved ? createProfileDraft(saved) : draft;
}

/** Local recommendations are configuration choices, never proof of provider availability. */
export function recommendedDraft(
    provider: Provider,
    model: string
): ProfileDraft | undefined {
    const recommendation = getRecommendedEmbeddingDefaults(provider, model);
    if (!recommendation) return undefined;
    return {
        ...createProfileDraft(),
        provider,
        model,
        dimensions: String(recommendation.dimensions),
        embeddingPreset: recommendation.embeddingPreset,
        indexType: recommendation.indexType,
        preparation: recommendation.preparation,
    };
}

export function profileDifferences(
    draft: ProfileDraft
): (keyof ProfileDraft)[] {
    const recommended = recommendedDraft(draft.provider, draft.model);
    return recommended
        ? (Object.keys(recommended) as (keyof ProfileDraft)[]).filter((key) =>
              key === 'metadataRows'
                  ? draft.metadataRows.length > 0
                  : draft[key] !== recommended[key]
          )
        : ['model'];
}

function inactiveNumber(
    value: string,
    minimum: number,
    maximum: number,
    fallback: number,
    integer = false
) {
    const number = value.trim() === '' ? Number.NaN : Number(value);
    return Number.isFinite(number) &&
        (!integer || Number.isInteger(number)) &&
        number >= minimum &&
        number <= maximum
        ? number
        : fallback;
}

/** Preserve valid inactive settings; an irrelevant blank must not block another strategy. */
export function profileFromDraft(draft: ProfileDraft) {
    return collectionProfile.safeParse({
        provider: draft.provider,
        model: draft.model,
        dimensions:
            draft.dimensions.trim() === ''
                ? Number.NaN
                : Number(draft.dimensions),
        metric: 'cosine',
        numericType: 'float32',
        indexType: draft.indexType,
        embeddingPreset: draft.embeddingPreset,
        preparation: draft.preparation,
        metadataFields: Object.fromEntries(
            draft.metadataRows.map((row) => [row.key, row.type])
        ),
        chunkingStrategy: draft.chunkingStrategy,
        parentChild: draft.parentChild,
        chunking: {
            targetTokens: Number(draft.targetTokens || Number.NaN),
            overlapTokens:
                draft.overlapTokens.trim() === ''
                    ? Number.NaN
                    : Number(draft.overlapTokens),
            minTokens: Number(draft.minTokens || Number.NaN),
            maxTokens: Number(draft.maxTokens || Number.NaN),
            semanticPercentile:
                draft.chunkingStrategy === 'SEMANTIC'
                    ? Number(draft.semanticPercentile || Number.NaN)
                    : inactiveNumber(draft.semanticPercentile, 1, 99, 90),
            parentMaxTokens: draft.parentChild
                ? Number(draft.parentMaxTokens || Number.NaN)
                : inactiveNumber(draft.parentMaxTokens, 32, 32_768, 2048, true),
        },
    });
}

/** Finite localized client errors supplement, but never replace, server validation. */
export function validateProfileDraft(
    draft: ProfileDraft
):
    | 'metadata'
    | 'dimensions'
    | 'hnsw'
    | 'preset'
    | 'chunking'
    | 'invalid'
    | null {
    const keys = draft.metadataRows.map((row) => row.key);
    if (
        keys.length > 20 ||
        new Set(keys).size !== keys.length ||
        keys.some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key))
    )
        return 'metadata';
    const model = getReviewedEmbeddingProfile(draft.provider, draft.model);
    if (
        model &&
        !supportsReviewedEmbeddingDimensions(model, Number(draft.dimensions))
    )
        return 'dimensions';
    if (draft.indexType === 'HNSW' && Number(draft.dimensions) > 2000)
        return 'hnsw';
    if (draft.provider !== 'OLLAMA' && draft.embeddingPreset !== 'GENERIC')
        return 'preset';
    const parsed = profileFromDraft(draft);
    if (!parsed.success)
        return parsed.error.issues.some(
            (issue) => issue.path[0] === 'chunking' || issue.code === 'custom'
        )
            ? 'chunking'
            : 'invalid';
    return null;
}
