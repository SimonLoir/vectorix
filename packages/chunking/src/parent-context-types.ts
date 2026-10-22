import type { PlannedChunk } from './types';

export const PARENT_CONTEXT_VERSION = 'parent-context-utf8-v1';
export const MAX_PARENT_CONTEXT_ROWS = 200_000;
export const MAX_PARENT_CONTEXT_TEXT_BYTES = 128 * 1024 ** 2;
export const MAX_PARENT_CONTEXT_SOURCE_SPAN_BYTES = 32 * 1024 ** 2;

/** Independent context cap and combined child-plus-parent materialization budgets. */
export interface ParentContextOptions {
    parentMaxTokens: number;
    maxRows?: number;
    maxTextBytes?: number;
    maxSourceSpanBytes?: number;
}

export interface ParentContextLayout {
    version: typeof PARENT_CONTEXT_VERSION;
    /** Parents occupy the ordinal suffix after the unchanged child array. */
    parents: PlannedChunk[];
    /** Array index is a child ordinal; value is its parent's suffix ordinal. */
    childParentOrdinals: number[];
}
