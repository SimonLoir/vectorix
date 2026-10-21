import { ragV1 } from '../v1-implementer';
import { createCredential } from '../services/credentials';
export const createCredentialHandler = ragV1.credentials.create.handler(
    ({ context, input }) => createCredential(context, input)
);
