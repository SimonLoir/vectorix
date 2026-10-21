/** Shared infrastructure permissions; product domains add their own resources. */
export const businessStatements = {
    settings: ['read', 'update', 'delete'],
    dashboard: ['read'],
} as const;
export type PermissionSet = Record<string, string[]>;
/** Clone immutable role statements for Better Auth. */
export function copyPermissions(
    statements: Record<string, readonly string[]>
): PermissionSet {
    return Object.fromEntries(
        Object.entries(statements).map(([key, actions]) => [key, [...actions]])
    );
}
