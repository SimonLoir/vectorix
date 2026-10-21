import type { PermissionSet } from './catalogue';
/** Extension point for operations with optional privileged effects. */
export function compoundPermissions(
    _operation: string,
    _input: unknown
): PermissionSet {
    void _operation;
    void _input;
    return {};
}
