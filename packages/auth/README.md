# Authentication and permissions

Better Auth stores hashed passwords, sessions, organizations, dynamic roles, API keys, passkeys, and TOTP two-factor authentication. API key and administrative operations check current permissions and the active organization. Private operations absent from the permission catalog are denied.

A user session is required for notifications and global administration. API keys cannot create other keys, manage members, change roles, or access superadmin routes. Permission initialization grants no automatic privileges to existing keys.

Configure `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `PASSKEY_RP_ID`, and `PASSKEY_ORIGINS`. Two-factor secrets and recovery codes are encrypted. A sign-in notification is created only after successful authentication; failure to record it does not block sign-in.
