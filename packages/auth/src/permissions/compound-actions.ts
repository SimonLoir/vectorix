import type { PermissionSet } from './catalogue';
/** Extension point for operations with optional privileged effects. */
export function compoundPermissions(
    _operation: string,
    _input: unknown
): PermissionSet {
    if (
        _operation === 'admin.rag.collections.create' &&
        typeof _input === 'object' &&
        _input !== null &&
        (!('grantCreatorRead' in _input) || _input.grantCreatorRead !== false)
    )
        return { ragCollection: ['read'] };
    return {};
}
