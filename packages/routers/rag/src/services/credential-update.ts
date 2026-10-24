import type { Prisma } from '@repo/db';
import { encrypt } from '@routers/utils/encryption';
import { credentialUpdateData } from '@repo/api-contracts/v1/rag/credentials';
import type { credentialDto, StoredCredential } from './credential-data';

type CredentialUpdateData = typeof credentialUpdateData._output;

/**
 * True when an endpoint, S3 bucket, or S3 addressing mode changes.
 * Path style can change the SDK's final request authority. Region alone does
 * not change the explicitly configured endpoint.
 */
export function changesSecretDestination(
    current: ReturnType<typeof credentialDto>['data'],
    next: CredentialUpdateData
): boolean {
    return (
        current.endpoint !== next.endpoint ||
        (current.provider === 'S3' &&
            next.provider === 'S3' &&
            (current.bucket !== next.bucket ||
                current.forcePathStyle !== next.forcePathStyle))
    );
}

/**
 * A changed destination must not reuse stored credentials its editor did not
 * supply: every secret field is required in the same request. An Ollama
 * credential without a key, or an explicit key removal, has no stored key to reuse.
 */
export function suppliesSecretsForDestination(
    current: ReturnType<typeof credentialDto>['data'],
    next: CredentialUpdateData
): boolean {
    switch (next.provider) {
        case 'S3':
            return (
                next.accessKeyId !== undefined &&
                next.secretAccessKey !== undefined
            );
        case 'OLLAMA':
            return (
                next.apiKey !== undefined ||
                (current.provider === 'OLLAMA' && current.apiKey === null)
            );
        default:
            return next.apiKey !== undefined;
    }
}

/** Preserve omitted secrets byte-for-byte; full replacement can repair corrupt ciphertext. */
export async function updateProviderData(
    db: Prisma.TransactionClient,
    current: StoredCredential,
    inputData: CredentialUpdateData
) {
    switch (inputData.provider) {
        case 'S3':
            await db.s3Credentials.update({
                where: { id: current.id },
                data: {
                    endpoint: inputData.endpoint,
                    bucket: inputData.bucket,
                    region: inputData.region,
                    forcePathStyle: inputData.forcePathStyle,
                    ...(inputData.accessKeyId === undefined
                        ? {}
                        : {
                              accessKeyId: await encrypt(inputData.accessKeyId),
                          }),
                    ...(inputData.secretAccessKey === undefined
                        ? {}
                        : {
                              secretAccessKey: await encrypt(
                                  inputData.secretAccessKey
                              ),
                          }),
                },
            });
            break;
        case 'OLLAMA':
            await db.ollamaCredentials.update({
                where: { id: current.id },
                data: {
                    endpoint: inputData.endpoint,
                    ...(inputData.apiKey === undefined
                        ? {}
                        : {
                              apiKey:
                                  inputData.apiKey === null
                                      ? null
                                      : await encrypt(inputData.apiKey),
                          }),
                },
            });
            break;
        case 'COHERE':
            await db.cohereCredentials.update({
                where: { id: current.id },
                data: {
                    endpoint: inputData.endpoint,
                    ...(inputData.apiKey === undefined
                        ? {}
                        : { apiKey: await encrypt(inputData.apiKey) }),
                },
            });
            break;
        case 'VOYAGE':
            await db.voyageCredentials.update({
                where: { id: current.id },
                data: {
                    endpoint: inputData.endpoint,
                    ...(inputData.apiKey === undefined
                        ? {}
                        : { apiKey: await encrypt(inputData.apiKey) }),
                },
            });
            break;
        case 'OPENAI':
            await db.openAICredentials.update({
                where: { id: current.id },
                data: {
                    endpoint: inputData.endpoint,
                    ...(inputData.apiKey === undefined
                        ? {}
                        : { apiKey: await encrypt(inputData.apiKey) }),
                },
            });
            break;
        case 'MISTRAL':
            await db.mistralCredentials.update({
                where: { id: current.id },
                data: {
                    endpoint: inputData.endpoint,
                    ...(inputData.apiKey === undefined
                        ? {}
                        : { apiKey: await encrypt(inputData.apiKey) }),
                },
            });
            break;
    }
}
