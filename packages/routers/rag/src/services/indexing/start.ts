import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    acceptIndexGeneration,
    type FirstIndexInput,
} from './generation-acceptance';

/** Preserve V1 first-index semantics; only the dedicated rebuild operation can accept a successor to an active generation. */
export function startIndex(context: AuthorizedContext, input: FirstIndexInput) {
    return acceptIndexGeneration(context, input);
}
