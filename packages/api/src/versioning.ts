export const VECTORIX_API_VERSION_HEADER = 'Vectorix-API-Version';
export const VECTORIX_API_REVISION_HEADER = 'Vectorix-API-Revision';

export type VectorixApiReleaseStatus = 'current' | 'supported' | 'deprecated';

export type VectorixApiVersion = Readonly<{
    major: number;
    revision: number;
    status: VectorixApiReleaseStatus;
}>;

/**
 * Initial immutable Vectorix API contract baseline.
 *
 * Compatible additions increment `revision`; breaking changes require a new
 * `major` and must leave this contract available while it is supported.
 */
export const VECTORIX_API_V1 = {
    major: 1,
    revision: 17,
    status: 'current',
} as const satisfies VectorixApiVersion;

export const CURRENT_VECTORIX_API_VERSION = VECTORIX_API_V1;

/**
 * Formats API metadata for the OpenAPI `info.version` field. The URL contains
 * only the major version; the compatible revision remains metadata.
 */
export function formatVectorixApiVersion(
    version: Pick<VectorixApiVersion, 'major' | 'revision'>
) {
    return `${version.major}.${version.revision}.0`;
}
