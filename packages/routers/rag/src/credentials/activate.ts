import { ragV1 } from '../v1-implementer';
import { activateCredential } from '../services/credentials';
export const activateCredentialHandler = ragV1.credentials.activate.handler(
    ({ context, input }) => activateCredential(context, input.id)
);
