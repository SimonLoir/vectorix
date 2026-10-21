import type { passkey } from '@better-auth/passkey';

type PasskeyOptions = NonNullable<Parameters<typeof passkey>[0]>;
type Environment = Readonly<Record<string, string | undefined>>;

const readValue = (environment: Environment, key: string) => {
    const value = environment[key]?.trim();
    return value && value.length > 0 ? value : undefined;
};

/**
 * Builds the WebAuthn relying-party options for the shared Better Auth server.
 *
 * The API (`api.vectorix.app`) and the dashboard (`app.vectorix.app`) live on
 * sibling hosts, so the default RP ID (the `BETTER_AUTH_URL` hostname) is
 * rejected by browsers. `PASSKEY_RP_ID` (falling back to `ROOT_DOMAIN`, without
 * its leading dot) must be the registrable parent domain shared by every
 * dashboard origin. `PASSKEY_ORIGINS` optionally pins the accepted browser
 * origins; when absent Better Auth keeps checking the request `Origin` header.
 * Changing the RP ID invalidates passkeys registered under the previous one.
 */
export function getPasskeyOptions(
    environment: Environment = process.env
): PasskeyOptions {
    const rpID = (
        readValue(environment, 'PASSKEY_RP_ID') ??
        readValue(environment, 'ROOT_DOMAIN')
    )?.replace(/^\.+/, '');
    const origins = readValue(environment, 'PASSKEY_ORIGINS')
        ?.split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter((origin) => origin.length > 0);

    return {
        rpName: readValue(environment, 'PASSKEY_RP_NAME') ?? 'Vectorix',
        ...(rpID && { rpID }),
        ...(origins && origins.length > 0 && { origin: origins }),
    };
}
