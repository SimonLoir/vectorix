import { ragV1 } from '../v1-implementer';
import { deleteCredential } from '../services/credentials';
export const deleteCredentialHandler = ragV1.credentials.delete.handler(
    ({ context, input }) => deleteCredential(context, input)
);
