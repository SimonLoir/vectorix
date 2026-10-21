import { type Prisma } from '@repo/db';
import { CredentialsModelSchema } from '@repo/db/schemas';
import { encrypt, decrypt } from '@routers/utils/encryption';
import {
    credentialData,
    credentialView,
} from '@repo/api-contracts/v1/rag/credentials';
import { ORPCError } from '@orpc/server';

export const credentialInclude = {
    s3: true,
    ollama: true,
    cohere: true,
    voyage: true,
    openai: true,
    mistral: true,
    selections: true,
} as const;
export type StoredCredential = Prisma.CredentialsGetPayload<{
    include: typeof credentialInclude;
}>;
// Internal persisted metadata validation derives from the generated model.
const metadata = CredentialsModelSchema.pick({
    id: true,
    name: true,
    provider: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
});

/** Convert explicitly selected provider data to a public, masked DTO without ever decrypting it. */
export function credentialDto(value: StoredCredential) {
    const common = {
        ...metadata.parse(value),
        active: value.selections.length > 0,
    };
    const masked = '********' as const;
    switch (value.provider) {
        case 'S3':
            if (value.s3)
                return credentialView.parse({
                    ...common,
                    data: {
                        provider: 'S3',
                        endpoint: value.s3.endpoint,
                        region: value.s3.region,
                        bucket: value.s3.bucket,
                        forcePathStyle: value.s3.forcePathStyle,
                        accessKeyId: masked,
                        secretAccessKey: masked,
                    },
                });
            break;
        case 'OLLAMA':
            if (value.ollama)
                return credentialView.parse({
                    ...common,
                    data: {
                        provider: 'OLLAMA',
                        endpoint: value.ollama.endpoint,
                        apiKey: value.ollama.apiKey ? masked : null,
                    },
                });
            break;
        case 'COHERE':
            if (value.cohere)
                return credentialView.parse({
                    ...common,
                    data: {
                        provider: 'COHERE',
                        endpoint: value.cohere.endpoint,
                        apiKey: masked,
                    },
                });
            break;
        case 'VOYAGE':
            if (value.voyage)
                return credentialView.parse({
                    ...common,
                    data: {
                        provider: 'VOYAGE',
                        endpoint: value.voyage.endpoint,
                        apiKey: masked,
                    },
                });
            break;
        case 'OPENAI':
            if (value.openai)
                return credentialView.parse({
                    ...common,
                    data: {
                        provider: 'OPENAI',
                        endpoint: value.openai.endpoint,
                        apiKey: masked,
                    },
                });
            break;
        case 'MISTRAL':
            if (value.mistral)
                return credentialView.parse({
                    ...common,
                    data: {
                        provider: 'MISTRAL',
                        endpoint: value.mistral.endpoint,
                        apiKey: masked,
                    },
                });
            break;
    }
    throw new ORPCError('CONFLICT', {
        message: 'Credential provider configuration is incomplete.',
    });
}

/** Decryption is server-only. Corrupt configured data is an error, never a reason to use environment defaults. */
export function decryptCredential(value: StoredCredential) {
    try {
        switch (value.provider) {
            case 'S3':
                if (value.s3)
                    return credentialData.parse({
                        provider: 'S3',
                        endpoint: value.s3.endpoint,
                        region: value.s3.region,
                        bucket: value.s3.bucket,
                        forcePathStyle: value.s3.forcePathStyle,
                        accessKeyId: decrypt(value.s3.accessKeyId),
                        secretAccessKey: decrypt(value.s3.secretAccessKey),
                    });
                break;
            case 'OLLAMA':
                if (value.ollama)
                    return credentialData.parse({
                        provider: 'OLLAMA',
                        endpoint: value.ollama.endpoint,
                        apiKey: value.ollama.apiKey
                            ? decrypt(value.ollama.apiKey)
                            : null,
                    });
                break;
            case 'COHERE':
                if (value.cohere)
                    return credentialData.parse({
                        provider: 'COHERE',
                        endpoint: value.cohere.endpoint,
                        apiKey: decrypt(value.cohere.apiKey),
                    });
                break;
            case 'VOYAGE':
                if (value.voyage)
                    return credentialData.parse({
                        provider: 'VOYAGE',
                        endpoint: value.voyage.endpoint,
                        apiKey: decrypt(value.voyage.apiKey),
                    });
                break;
            case 'OPENAI':
                if (value.openai)
                    return credentialData.parse({
                        provider: 'OPENAI',
                        endpoint: value.openai.endpoint,
                        apiKey: decrypt(value.openai.apiKey),
                    });
                break;
            case 'MISTRAL':
                if (value.mistral)
                    return credentialData.parse({
                        provider: 'MISTRAL',
                        endpoint: value.mistral.endpoint,
                        apiKey: decrypt(value.mistral.apiKey),
                    });
                break;
        }
    } catch {
        /* Never expose parser input, ciphertext, or crypto diagnostics. */
    }
    throw new ORPCError('CONFLICT', {
        message:
            'Configured credentials cannot be read. Update the organization configuration.',
    });
}

export async function encryptedProviderData(
    input: typeof credentialData._output
): Promise<
    Pick<
        Prisma.CredentialsCreateInput,
        's3' | 'ollama' | 'cohere' | 'voyage' | 'openai' | 'mistral'
    >
> {
    switch (input.provider) {
        case 'S3':
            return {
                s3: {
                    create: {
                        endpoint: input.endpoint,
                        region: input.region,
                        bucket: input.bucket,
                        forcePathStyle: input.forcePathStyle,
                        accessKeyId: await encrypt(input.accessKeyId),
                        secretAccessKey: await encrypt(input.secretAccessKey),
                    },
                },
            };
        case 'OLLAMA':
            return {
                ollama: {
                    create: {
                        endpoint: input.endpoint,
                        apiKey: input.apiKey
                            ? await encrypt(input.apiKey)
                            : null,
                    },
                },
            };
        case 'COHERE':
            return {
                cohere: {
                    create: {
                        endpoint: input.endpoint,
                        apiKey: await encrypt(input.apiKey),
                    },
                },
            };
        case 'VOYAGE':
            return {
                voyage: {
                    create: {
                        endpoint: input.endpoint,
                        apiKey: await encrypt(input.apiKey),
                    },
                },
            };
        case 'OPENAI':
            return {
                openai: {
                    create: {
                        endpoint: input.endpoint,
                        apiKey: await encrypt(input.apiKey),
                    },
                },
            };
        case 'MISTRAL':
            return {
                mistral: {
                    create: {
                        endpoint: input.endpoint,
                        apiKey: await encrypt(input.apiKey),
                    },
                },
            };
    }
}
