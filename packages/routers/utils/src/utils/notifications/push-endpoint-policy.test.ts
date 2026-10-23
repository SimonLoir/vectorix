import assert from 'node:assert/strict';
import test from 'node:test';
import {
    admitPushEndpoint,
    createPushEndpointPolicy,
    PushEndpointPolicyConfigurationError,
} from './push-endpoint-policy';

void test('native defaults trust only the selected vendor DNS namespaces with complete label boundaries', () => {
    const policy = createPushEndpointPolicy();
    for (const endpoint of [
        'https://fcm.googleapis.com/wp/new-opaque-token',
        'https://fcm.googleapis.com/fcm/send/legacy-opaque-token',
        'https://push.services.mozilla.com/wpush/v1/token',
        'https://updates.push.services.mozilla.com/wpush/v1/token',
        'https://a.b.push.services.mozilla.com/opaque-new-path',
        'https://notify.windows.com/?token=opaque',
        'https://db3.notify.windows.com/?token=opaque',
        'https://cloud.notify.windows.com/opaque',
        'https://push.apple.com/opaque',
        'https://web.push.apple.com/opaque',
        'https://a.b.push.apple.com/opaque',
    ]) {
        assert.ok(admitPushEndpoint(endpoint, policy));
    }
    for (const endpoint of [
        'https://push.example.test/opaque',
        'https://foo.fcm.googleapis.com/opaque',
        'https://fcm.googleapis.com.attacker.test/opaque',
        'https://evilpush.apple.com/opaque',
        'https://evilnotify.windows.com/opaque',
        'https://evilpush.services.mozilla.com/opaque',
        'https://push.apple.com.attacker.test/opaque',
        'https://updates.push.services.mozilla.com.attacker.test/opaque',
        'https://db3.notify.windows.com.attacker.test/opaque',
        'https://apple.com/opaque',
        'https://mozilla.com/opaque',
        'https://windows.com/opaque',
    ]) {
        assert.equal(admitPushEndpoint(endpoint, policy), null);
    }
});

void test('admission preserves opaque identity and exact raw path/query while normalizing only destination metadata', () => {
    const policy = createPushEndpointPolicy();
    const endpoint =
        'https://FCM.GOOGLEAPIS.COM:443/wp/a/../b%2f%2F//?token=A%2Bb&same=1&same=2&empty=';
    assert.deepEqual(admitPushEndpoint(endpoint, policy), {
        endpoint,
        hostname: 'fcm.googleapis.com',
        origin: 'https://fcm.googleapis.com',
        requestPath: '/wp/a/../b%2f%2F//?token=A%2Bb&same=1&same=2&empty=',
    });
    assert.equal(
        admitPushEndpoint('https://web.push.apple.com', policy)?.requestPath,
        '/'
    );
    assert.equal(
        admitPushEndpoint('https://db3.notify.windows.com?token=A%2fB', policy)
            ?.requestPath,
        '/?token=A%2fB'
    );
});

void test('unsafe URL forms, IP spellings and parser-ambiguous authorities never gain admission', () => {
    const policy = createPushEndpointPolicy();
    for (const endpoint of [
        null,
        undefined,
        42,
        {},
        [],
        '',
        'not a URL',
        'http://fcm.googleapis.com/token',
        'https:fcm.googleapis.com/token',
        '//fcm.googleapis.com/token',
        'https://fcm.googleapis.com:444/token',
        'https://fcm.googleapis.com:0443/token',
        'https://fcm.googleapis.com:/token',
        'https://user:secret@fcm.googleapis.com/token',
        'https://@fcm.googleapis.com/token',
        'https://fcm.googleapis.com@127.0.0.1/token',
        'https://fcm.googleapis.com/token#fragment',
        'https://fcm.googleapis.com/token#',
        'https://fcm.googleapis.com./token',
        'https://fcm%2egoogleapis.com/token',
        'https://a..push.apple.com/token',
        'https://-a.push.apple.com/token',
        'https://a-.push.apple.com/token',
        'https://127.0.0.1/token',
        'https://10.0.0.5/token',
        'https://169.254.169.254/token',
        'https://8.8.8.8/token',
        'https://2130706433/token',
        'https://0x7f000001/token',
        'https://0177.0.0.1/token',
        'https://127.1/token',
        'https://[::1]/token',
        'https://[::ffff:127.0.0.1]/token',
        'https://[2001:4860:4860::8888]/token',
        String.raw`https://fcm.googleapis.com\@attacker.test/token`,
        'https://fcM.googleapıS.com/token',
    ]) {
        assert.equal(admitPushEndpoint(endpoint, policy), null);
    }
});

void test('raw whitespace, controls, backslashes and lone surrogates are rejected before URL normalization', () => {
    const policy = createPushEndpointPolicy();
    for (const code of [0, 9, 10, 13, 31, 32, 127, 159, 160, 0x20_28]) {
        const character = String.fromCodePoint(code);
        for (const endpoint of [
            `${character}https://fcm.googleapis.com/token`,
            `https://fcm.googleapis.com/token${character}`,
            `https://fcm.googleapis.com/to${character}ken`,
        ]) {
            assert.equal(admitPushEndpoint(endpoint, policy), null);
        }
    }
    for (const code of [0xd8_00, 0xdf_ff]) {
        assert.equal(
            admitPushEndpoint(
                `https://fcm.googleapis.com/${String.fromCodePoint(code)}`,
                policy
            ),
            null
        );
    }
    assert.equal(
        admitPushEndpoint(
            String.raw`https://fcm.googleapis.com/to\ken`,
            policy
        ),
        null
    );
});

void test('an exact operator-origin list replaces every native default and never grants sibling namespaces', () => {
    const policy = createPushEndpointPolicy(
        ' https://PUSH.EXAMPLE.TEST:443/, ,https://push.example.test,https://other.example.test '
    );
    assert.deepEqual(policy, {
        source: 'OPERATOR',
        origins: ['https://push.example.test', 'https://other.example.test'],
    });
    for (const endpoint of [
        'https://push.example.test/new/path?opaque=1',
        'https://other.example.test:443/path',
    ]) {
        assert.ok(admitPushEndpoint(endpoint, policy));
    }
    for (const endpoint of [
        'https://fcm.googleapis.com/wp/token',
        'https://web.push.apple.com/token',
        'https://sibling.push.example.test/token',
        'https://push.example.test.attacker.test/token',
        'https://push.example.test:444/token',
    ]) {
        assert.equal(admitPushEndpoint(endpoint, policy), null);
    }
    assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.origins));
});

void test('invalid or empty supplied configuration fails with a fixed error and no native fallback', () => {
    for (const configuration of [
        '',
        ' , , ',
        'not a URL',
        'http://push.example.test',
        'https://push.example.test/path',
        'https://push.example.test/../',
        'https://push.example.test?query=1',
        'https://push.example.test/?',
        'https://push.example.test#',
        'https://user:private@push.example.test',
        'https://push.example.test:8443',
        'https://*.example.test',
        'https://127.0.0.1',
        'https://[::1]',
        'https://push.example.test.',
        'https://push.example.test,PRIVATE_CONFIGURATION_SENTINEL',
    ]) {
        let captured: unknown;
        try {
            createPushEndpointPolicy(configuration);
        } catch (error) {
            captured = error;
        }
        assert.ok(captured instanceof PushEndpointPolicyConfigurationError);
        assert.equal(
            captured.message,
            'Web Push endpoint policy is unavailable.'
        );
        assert.equal(captured.cause, undefined);
        assert.ok(!captured.message.includes('PRIVATE_CONFIGURATION_SENTINEL'));
    }
});

void test('configuration and endpoint bounds are finite without weakening the maximum valid cases', () => {
    const origins = Array.from(
        { length: 32 },
        (_, index) => `https://push${index}.example.test`
    );
    const policy = createPushEndpointPolicy(origins.join(','));
    assert.equal(policy.origins.length, 32);
    assert.throws(
        () =>
            createPushEndpointPolicy(
                [...origins, 'https://extra.example.test'].join(',')
            ),
        PushEndpointPolicyConfigurationError
    );
    assert.throws(
        () => createPushEndpointPolicy('x'.repeat(8193)),
        PushEndpointPolicyConfigurationError
    );
    const prefix = 'https://fcm.googleapis.com/';
    const native = createPushEndpointPolicy();
    assert.ok(
        admitPushEndpoint(prefix + 'a'.repeat(2048 - prefix.length), native)
    );
    assert.equal(
        admitPushEndpoint(prefix + 'a'.repeat(2049 - prefix.length), native),
        null
    );
});
