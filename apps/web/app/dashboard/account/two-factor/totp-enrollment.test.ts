import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTotpEnrollment } from './totp-enrollment';

void test('only the SDK TOTP enrollment branch exposes URI and backup codes', () => {
    const response = {
        method: 'totp',
        totpURI: 'otpauth://totp/fixture?secret=TESTONLY',
        backupCodes: ['PUBLIC_TEST_BACKUP'],
    } satisfies NonNullable<Parameters<typeof getTotpEnrollment>[0]>;
    assert.equal(getTotpEnrollment(response), response);
    assert.equal(getTotpEnrollment(response)?.totpURI, response.totpURI);
});

void test('an OTP or absent enrollment response cannot expose TOTP fields or advance setup', () => {
    const response = { method: 'otp' } satisfies NonNullable<
        Parameters<typeof getTotpEnrollment>[0]
    >;
    let fieldReads = 0;
    for (const property of ['totpURI', 'backupCodes'])
        Object.defineProperty(response, property, {
            get() {
                fieldReads++;
                throw new Error('Unexpected TOTP field read.');
            },
        });
    assert.equal(getTotpEnrollment(response), null);
    assert.equal(fieldReads, 0);
    assert.equal(getTotpEnrollment(null), null);
    assert.equal(getTotpEnrollment(), null);
});
