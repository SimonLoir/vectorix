import type { Prisma } from '@repo/db';
import { credentialSecretContext, encrypt } from '@routers/utils/encryption';
import { credentialUpdateData } from '@repo/api-contracts/v1/rag/credentials';
import type { StoredCredential } from './credential-data';

/** Preserve omitted secrets byte-for-byte; full replacement can repair corrupt ciphertext. */
export async function updateProviderData(
    db: Prisma.TransactionClient,
    current: StoredCredential,
    inputData: typeof credentialUpdateData._output
) {
    const seal = (
        plaintext: string,
        field: 'accessKeyId' | 'secretAccessKey' | 'apiKey'
    ) =>
        encrypt(
            plaintext,
            credentialSecretContext(current.organizationId, current.id, field)
        );
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
                              accessKeyId: await seal(
                                  inputData.accessKeyId,
                                  'accessKeyId'
                              ),
                          }),
                    ...(inputData.secretAccessKey === undefined
                        ? {}
                        : {
                              secretAccessKey: await seal(
                                  inputData.secretAccessKey,
                                  'secretAccessKey'
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
                                      : await seal(inputData.apiKey, 'apiKey'),
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
                        : { apiKey: await seal(inputData.apiKey, 'apiKey') }),
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
                        : { apiKey: await seal(inputData.apiKey, 'apiKey') }),
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
                        : { apiKey: await seal(inputData.apiKey, 'apiKey') }),
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
                        : { apiKey: await seal(inputData.apiKey, 'apiKey') }),
                },
            });
            break;
    }
}
