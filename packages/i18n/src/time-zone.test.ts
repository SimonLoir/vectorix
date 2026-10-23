import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_VECTORIX_TIME_ZONE,
    resolveVectorixTimeZone,
} from './time-zone';

void test('missing, empty and invalid time zones preserve the Brussels fallback', () => {
    assert.equal(DEFAULT_VECTORIX_TIME_ZONE, 'Europe/Brussels');
    for (const value of [undefined, '', '  ', 'not/a-time-zone', 'UTC\u0000']) {
        assert.equal(resolveVectorixTimeZone(value), 'Europe/Brussels');
    }
});

void test('Intl-accepted configured zones are trimmed and returned without a locale dependency', () => {
    for (const value of [
        'UTC',
        'Europe/Brussels',
        'Pacific/Honolulu',
        'Etc/UTC',
    ]) {
        assert.equal(resolveVectorixTimeZone(` ${value} `), value);
    }
});

void test('a rejected zone cannot affect a later independent resolution', () => {
    assert.equal(resolveVectorixTimeZone('not/a-time-zone'), 'Europe/Brussels');
    assert.equal(resolveVectorixTimeZone('UTC'), 'UTC');
    assert.equal(resolveVectorixTimeZone(), 'Europe/Brussels');
});
