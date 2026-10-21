import { twoFactor } from 'better-auth/plugins';

const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;

/**
 * Optional, per-user two-factor authentication (TOTP + backup codes).
 *
 * Better Auth only challenges credential sign-ins (`/sign-in/email`): the
 * first session is deleted and the client receives `twoFactorRedirect` until
 * `/two-factor/verify-totp` or `/two-factor/verify-backup-code` succeeds.
 * Passkeys, CLI device approval and organization API keys are not challenged.
 * Backup codes are stored encrypted with the auth secret; a trusted device
 * skips the challenge for 30 days and is rotated on each use.
 */
export function createTwoFactorPlugin() {
    return twoFactor({
        issuer: 'Vectorix',
        backupCodeOptions: {
            amount: 10,
            length: 10,
            storeBackupCodes: 'encrypted',
        },
        trustDeviceMaxAge: THIRTY_DAYS_IN_SECONDS,
    });
}
