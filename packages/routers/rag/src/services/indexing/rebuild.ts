import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    acceptIndexGeneration,
    type RebuildIndexInput,
} from './generation-acceptance';

/** Accept a bounded successor for the exact active generation and saved draft revision; search remains on its predecessor. */
export function rebuildIndex(
    context: AuthorizedContext,
    input: RebuildIndexInput
) {
    return acceptIndexGeneration(context, input);
}
