export const ACCOUNT_CREATION_ENV_NAME = 'ALLOW_ACCOUNT_CREATION';

/**
 * Parses the account-creation flag. Signup is closed by default and only
 * explicit truthy values enable it.
 */
export function parseAccountCreationAllowed(value: string | undefined) {
    return (
        value !== undefined &&
        ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
    );
}

/** Returns whether public email/password account creation is enabled. */
export function isAccountCreationAllowed() {
    return parseAccountCreationAllowed(process.env[ACCOUNT_CREATION_ENV_NAME]);
}
