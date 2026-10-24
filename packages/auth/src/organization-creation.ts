export const ORGANIZATION_CREATION_ENV_NAME = 'ALLOW_ORGANIZATION_CREATION';

/**
 * Parses the organization-creation flag. Creation is closed by default and
 * only explicit truthy values enable it.
 */
export function parseOrganizationCreationAllowed(value: string | undefined) {
    return (
        value !== undefined &&
        ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
    );
}

/** Returns whether authenticated users may create organizations. */
export function isOrganizationCreationAllowed() {
    return parseOrganizationCreationAllowed(
        process.env[ORGANIZATION_CREATION_ENV_NAME]
    );
}
