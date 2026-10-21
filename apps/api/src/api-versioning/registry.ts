import type { AnyContractRouter } from '@orpc/contract';
import type { AnyRouter } from '@orpc/server';
import { router } from '@repo/api';
import { v1Contract } from '@repo/api-contracts/v1';
import { VECTORIX_API_V1, type VectorixApiVersion } from '@repo/api/versioning';

export type ApiVersionDefinition = VectorixApiVersion &
    Readonly<{
        router: AnyRouter;
        contract: AnyContractRouter;
        rpcPath: `/rpc/v${number}`;
        restPath: `/api/v${number}`;
        specPath: `/spec/v${number}.json`;
    }>;

function defineApiVersion(
    version: VectorixApiVersion,
    versionContract: AnyContractRouter,
    versionRouter: AnyRouter
): ApiVersionDefinition {
    return {
        ...version,
        contract: versionContract,
        router: versionRouter,
        rpcPath: `/rpc/v${version.major}`,
        restPath: `/api/v${version.major}`,
        specPath: `/spec/v${version.major}.json`,
    };
}

/**
 * Single source of truth for every Vectorix API major that remains callable.
 * Add a new entry only for a breaking contract; compatible changes update the
 * revision of the existing entry without changing its public URL.
 */
export const API_VERSION_REGISTRY = [
    defineApiVersion(VECTORIX_API_V1, v1Contract, router),
] as const;

const currentVersions = API_VERSION_REGISTRY.filter(
    (version) => version.status === 'current'
);
const distinctMajors = new Set(
    API_VERSION_REGISTRY.map((version) => version.major)
);

if (currentVersions.length !== 1) {
    throw new Error(
        'The API registry must contain exactly one current version'
    );
}

if (distinctMajors.size !== API_VERSION_REGISTRY.length) {
    throw new Error('The API registry cannot contain duplicate major versions');
}

export const CURRENT_API_VERSION = currentVersions[0]!;

export type PublicApiVersion = Omit<
    ApiVersionDefinition,
    'contract' | 'router'
>;

/** Returns registry metadata that is safe to expose to API consumers. */
export function getPublicApiVersions(): PublicApiVersion[] {
    return API_VERSION_REGISTRY.map((version) => ({
        major: version.major,
        revision: version.revision,
        status: version.status,
        rpcPath: version.rpcPath,
        restPath: version.restPath,
        specPath: version.specPath,
    }));
}
