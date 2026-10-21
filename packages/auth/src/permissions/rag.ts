/** Organization permissions are prerequisites; content access still requires a collection grant. */
export const ragStatements = {
    ragCredentials: ['read', 'manage'],
    ragGroups: ['read', 'manage'],
    ragCollection: [
        'read',
        'create',
        'update',
        'delete',
        'manageDocuments',
        'manageGrants',
        'manageAll',
    ],
    ragLibrary: ['read', 'readAll', 'write'],
    ragAudit: ['read'],
    ragQuota: ['read'],
} as const;

export const ragMemberStatements = {
    ragCollection: ['read'],
    ragLibrary: ['read'],
} as const;
