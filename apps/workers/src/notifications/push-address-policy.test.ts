import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isPublicPushAddress,
    MAX_PUSH_DNS_ANSWERS,
    publicPushAddressAnswers,
} from './push-address-policy';

void test('ordinary public IPv4 and conservative global IPv6 are eligible', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34'])
        assert.equal(isPublicPushAddress(address, 4), true);
    for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111'])
        assert.equal(isPublicPushAddress(address, 6), true);
});

void test('IPv4 private, shared, special, documentation, multicast and reserved destinations fail closed', () => {
    for (const address of [
        '0.0.0.0',
        '0.255.255.255',
        '10.0.0.1',
        '100.64.0.0',
        '100.127.255.255',
        '127.0.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '172.31.255.255',
        '192.0.0.9',
        '192.0.2.1',
        '192.31.196.1',
        '192.52.193.1',
        '192.88.99.1',
        '192.168.1.1',
        '192.175.48.1',
        '198.18.0.1',
        '198.19.255.255',
        '198.51.100.1',
        '203.0.113.1',
        '224.0.0.1',
        '239.255.255.255',
        '240.0.0.1',
        '255.255.255.255',
    ])
        assert.equal(isPublicPushAddress(address, 4), false);
    for (const address of [
        '100.63.255.255',
        '100.128.0.0',
        '172.15.255.255',
        '172.32.0.0',
    ])
        assert.equal(isPublicPushAddress(address, 4), true);
});

void test('IPv6 mapped, NAT64, local, transition and special ranges are never treated as public', () => {
    for (const address of [
        '::',
        '::1',
        '::ffff:8.8.8.8',
        '::ffff:127.0.0.1',
        '64:ff9b::808:808',
        '64:ff9b:1::1',
        '100::1',
        '100:0:0:1::1',
        '2001::1',
        '2001:2::1',
        '2001:20::1',
        '2001:db8::1',
        '2002:808:808::1',
        '2620:4f:8000::1',
        '3fff::1',
        '4000::1',
        '5f00::1',
        'fc00::1',
        'fd12::1',
        'fe80::1',
        'ff02::1',
        'fe80::1%lo',
    ])
        assert.equal(isPublicPushAddress(address, 6), false);
});

void test('malformed addresses and contradictory address families are denied', () => {
    for (const address of [
        '',
        'localhost',
        '127.1',
        '2130706433',
        '0x7f000001',
        '8.8.8.8 ',
        '008.8.8.8',
        '8.8.8.8\0',
    ])
        assert.equal(isPublicPushAddress(address, 4), false);
    assert.equal(isPublicPushAddress('8.8.8.8', 6), false);
    assert.equal(isPublicPushAddress('2606:4700::1111', 4), false);
    assert.equal(isPublicPushAddress('8.8.8.8', 0), false);
});

void test('the complete DNS answer set must be public and bounded; accepted answers are immutable copies', () => {
    assert.equal(publicPushAddressAnswers([]), null);
    assert.equal(
        publicPushAddressAnswers([
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 },
        ]),
        null
    );
    assert.equal(
        publicPushAddressAnswers([
            { address: '8.8.8.8', family: 4 },
            { address: 'fd00::1', family: 6 },
        ]),
        null
    );
    assert.equal(
        publicPushAddressAnswers(
            Array.from({ length: MAX_PUSH_DNS_ANSWERS + 1 }, () => ({
                address: '8.8.8.8',
                family: 4,
            }))
        ),
        null
    );
    const input = [{ address: '8.8.8.8', family: 4 }];
    const accepted = publicPushAddressAnswers(input);
    assert.ok(accepted);
    input[0]!.address = '127.0.0.1';
    assert.deepEqual(accepted, [{ address: '8.8.8.8', family: 4 }]);
    assert.equal(Object.isFrozen(accepted), true);
    assert.equal(Object.isFrozen(accepted[0]), true);
});
