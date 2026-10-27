import type { Prisma, RerankEndpointCredential } from '@repo/db';
import { RerankEndpointCredentialModelSchema } from '@repo/db/schemas';
import { rerankEndpointView } from '@repo/api-contracts/v1/rag/reranking-extended';
import {
    decrypt,
    rerankEndpointSecretContext,
} from '@routers/utils/encryption';
export { rerankEndpointSecretContext } from '@routers/utils/encryption';
import {
    assertRerankingEndpoint,
    normalizeRerankingEndpoint,
} from './endpoint-policy';
import { rerankError } from './errors';

const metadata = RerankEndpointCredentialModelSchema.pick({
    id: true,
    provider: true,
    name: true,
    revision: true,
    endpoint: true,
    active: true,
    createdAt: true,
    updatedAt: true,
});

/** Mask secrets without decrypting them, even for administrators. */
export function rerankEndpointDto(row: RerankEndpointCredential) {
    const visible = metadata.parse(row);
    return rerankEndpointView.parse({
        ...visible,
        apiKey: row.apiKey ? '********' : null,
    });
}

/** Preserve exact key bytes, but reject unusable blank/control-bearing secrets before storage or dispatch. */
export function validateRerankEndpointKey(value: string | null) {
    if (
        value !== null &&
        (!value.trim() ||
            value === '********' ||
            value.length > 8192 ||
            [...value].some((character) => {
                const code = character.codePointAt(0)!;
                return code < 32 || code === 127;
            }))
    )
        throw rerankError('CREDENTIALS_INVALID');
    return value;
}

/** Platform endpoint and key are a complete configuration, never combined with an organization row. */
export function platformRerankEndpoint() {
    try {
        const endpoint = normalizeRerankingEndpoint(
            process.env.VECTORIX_DEFAULT_TEI_ENDPOINT ?? ''
        );
        assertRerankingEndpoint('TEI', endpoint);
        const configuredKey = process.env.VECTORIX_DEFAULT_TEI_API_KEY;
        const apiKey = validateRerankEndpointKey(
            configuredKey === '' ? null : (configuredKey ?? null)
        );
        return { provider: 'TEI' as const, endpoint, apiKey };
    } catch {
        throw rerankError('CREDENTIALS_INVALID');
    }
}

/** Read a saved endpoint row, including inactive retained bindings; selection changes do not revoke them. */
export function decryptRerankEndpoint(row: RerankEndpointCredential) {
    try {
        if (row.provider !== 'TEI') throw rerankError('PROFILE_UNSUPPORTED');
        const endpoint = normalizeRerankingEndpoint(row.endpoint);
        assertRerankingEndpoint('TEI', endpoint);
        const apiKey =
            row.apiKey === null
                ? null
                : validateRerankEndpointKey(
                      decrypt(
                          row.apiKey,
                          rerankEndpointSecretContext(
                              row.organizationId,
                              row.id
                          )
                      )
                  );
        return { provider: 'TEI' as const, endpoint, apiKey };
    } catch {
        throw rerankError('CREDENTIALS_INVALID');
    }
}

/** Invalid or inactive organization configuration is explicit failure; fallback only when none exists. */
export async function resolveRerankEndpoint(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const active = await db.rerankEndpointCredential.findFirst({
        where: { organizationId, provider: 'TEI', active: true },
    });
    if (active)
        return {
            data: decryptRerankEndpoint(active),
            selfHostedCredentialId: active.id,
            credentialRevision: active.revision,
        };
    if (
        await db.rerankEndpointCredential.count({
            where: { organizationId, provider: 'TEI' },
        })
    )
        throw rerankError('CREDENTIALS_INVALID');
    return {
        data: platformRerankEndpoint(),
        selfHostedCredentialId: null,
        credentialRevision: null,
    };
}
