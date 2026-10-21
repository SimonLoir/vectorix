import { ragV1 } from '../v1-implementer';
import { updateCredential } from '../services/credentials';
export const updateCredentialHandler = ragV1.credentials.update.handler(
    ({ context, input }) => updateCredential(context, input)
);
