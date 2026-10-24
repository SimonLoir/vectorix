import type { getAuthClient } from '@repo/dashboard-core/lib/auth-client';

type EnrollmentData = NonNullable<
    Awaited<
        ReturnType<ReturnType<typeof getAuthClient>['twoFactor']['enable']>
    >['data']
>;

/** Only the native TOTP branch may advance authenticator enrollment; other methods keep the password step. */
export function getTotpEnrollment(data?: EnrollmentData | null) {
    if (!data || data.method !== 'totp') return null;
    return data;
}
