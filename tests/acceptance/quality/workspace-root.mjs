import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Locate tracked workspace markers, never a machine-specific checkout or local environment file. */
export function workspaceRoot() {
    let candidate = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 10; depth++) {
        if (
            existsSync(path.join(candidate, 'pnpm-workspace.yaml')) &&
            existsSync(path.join(candidate, 'packages/documents/src/index.ts'))
        )
            return candidate;
        const parent = path.dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
    }
    assert.fail('VECTORIX_WORKSPACE_NOT_FOUND');
}
