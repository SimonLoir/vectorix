import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    defaultLocale,
    normalizeLocale,
    resolveAcceptLanguageLocale,
    resolveLocale,
    resolveLocaleCookie,
    resolveRequestLocale,
    supportedLocales,
} from './locale';

void test('canonical dictionaries normalize case and supported regional language tags', () => {
    assert.deepEqual(supportedLocales, ['en', 'fr', 'nl-BE']);
    assert.equal(defaultLocale, 'en');
    for (const [preference, expected] of [
        ['en', 'en'],
        ['EN-us', 'en'],
        ['en-GB', 'en'],
        ['fr', 'fr'],
        ['FR-ca', 'fr'],
        [' fr-BE ', 'fr'],
        ['nl', 'nl-BE'],
        ['NL-be', 'nl-BE'],
        ['nl-NL', 'nl-BE'],
    ]) {
        assert.equal(normalizeLocale(preference), expected);
    }
});

void test('unknown and malformed preferences cannot become dictionary keys', () => {
    for (const preference of [
        undefined,
        null,
        1,
        {},
        ['fr'],
        '',
        'de-DE',
        '*',
        'english',
        'fr_',
        'fr-',
        'fr--BE',
        'en-US;q=1',
        'nl/BE',
        'fr-123456789',
        'fr\u0000',
    ]) {
        assert.equal(normalizeLocale(preference), null);
    }
});

void test('browser languages use quality before order and canonicalize regional tags', () => {
    assert.equal(
        resolveAcceptLanguageLocale(
            'de-DE, fr-CA;q=0.4, NL-nl;q=0.9, en;q=0.6'
        ),
        'nl-BE'
    );
    assert.equal(resolveAcceptLanguageLocale('fr;q=0.7, en;q=0.7'), 'fr');
    assert.equal(resolveAcceptLanguageLocale('en;q=0.7, fr;q=0.7'), 'en');
    assert.equal(resolveAcceptLanguageLocale('fr;q=0.9, EN-gb'), 'en');
    assert.equal(resolveAcceptLanguageLocale('fr; Q = 0.8, nl;q=0.5'), 'fr');
});

void test('zero weights never win browser selection, including regional and uppercase preferences', () => {
    assert.equal(resolveAcceptLanguageLocale('fr;q=0, nl-BE;q=0.1'), 'nl-BE');
    assert.equal(resolveAcceptLanguageLocale('FR-be;Q=0.000, en;q=0'), null);
    assert.equal(resolveAcceptLanguageLocale('fr;q=0, fr-CA;q=0.4'), 'fr');
    assert.equal(resolveLocale({ acceptLanguage: 'en;q=0' }), 'en');
});

void test('malformed, duplicate and out-of-range weights are ignored rather than promoted', () => {
    for (const preference of [
        'fr;q=2',
        'fr;q=-1',
        'fr;q=NaN',
        'fr;q=Infinity',
        'fr;q=',
        'fr;q=.9',
        'fr;q=0.1234',
        'fr;q=1.001',
        'fr;q=0;q=1',
        'fr;q=1;extra=1',
    ]) {
        assert.equal(
            resolveAcceptLanguageLocale(`${preference}, en;q=0.1`),
            'en'
        );
    }
    assert.equal(resolveAcceptLanguageLocale('fr;q=1.000, en;q=0.999'), 'fr');
    assert.equal(resolveAcceptLanguageLocale('*, de;q=1'), null);
});

void test('cookie then saved preference then browser then fallback determines the locale', () => {
    const preferences = {
        cookieLocale: 'NL-nl',
        savedLocale: 'fr-BE',
        acceptLanguage: 'en-US',
        fallback: 'fr',
    };
    assert.equal(resolveLocale(preferences), 'nl-BE');
    assert.equal(
        resolveLocale({ ...preferences, cookieLocale: 'unsupported' }),
        'fr'
    );
    assert.equal(
        resolveLocale({
            ...preferences,
            cookieLocale: null,
            savedLocale: null,
        }),
        'en'
    );
    assert.equal(resolveLocale({ fallback: 'NL-be' }), 'nl-BE');
    assert.equal(resolveLocale({ fallback: 'unsupported' }), 'en');
    assert.equal(resolveLocale(), 'en');
});

void test('the dashboard two-argument entrypoint retains cookie precedence and the English default', () => {
    assert.equal(resolveRequestLocale('fr', 'en;q=1'), 'fr');
    assert.equal(resolveRequestLocale('NL-BE', 'en;q=1'), 'nl-BE');
    assert.equal(resolveRequestLocale('unknown', 'fr;q=0, en;q=0.8'), 'en');
    assert.equal(resolveRequestLocale(undefined, null), 'en');
});

void test('locale cookies decode safely without reading similarly named cookies', () => {
    assert.equal(
        resolveLocaleCookie('session=synthetic; locale=NL%2DBE; theme=dark'),
        'nl-BE'
    );
    assert.equal(resolveLocaleCookie('otherlocale=fr; locale=en'), 'en');
    assert.equal(resolveLocaleCookie('locale=fr; locale=en'), 'fr');
    assert.equal(resolveLocaleCookie('locale=unknown; locale=fr'), null);
    for (const cookie of [
        null,
        undefined,
        {},
        'otherlocale=fr',
        'locale=%',
        'locale=%ED%A0%80',
    ]) {
        assert.equal(resolveLocaleCookie(cookie), null);
    }
    assert.equal(
        resolveLocale({
            cookieLocale: resolveLocaleCookie('locale=%'),
            savedLocale: 'fr',
        }),
        'fr'
    );
});

void test('language preference work is bounded before parsing oversized input', () => {
    assert.equal(normalizeLocale(`en${' '.repeat(126)}`), 'en');
    assert.equal(normalizeLocale(`en${' '.repeat(127)}`), null);
    assert.equal(resolveAcceptLanguageLocale(`fr${' '.repeat(4094)}`), 'fr');
    assert.equal(resolveAcceptLanguageLocale(`fr${' '.repeat(4095)}`), null);
    assert.equal(
        resolveAcceptLanguageLocale(
            [...Array.from({ length: 127 }, () => 'de'), 'fr'].join(',')
        ),
        'fr'
    );
    assert.equal(
        resolveAcceptLanguageLocale(
            [...Array.from({ length: 128 }, () => 'de'), 'fr'].join(',')
        ),
        null
    );
    assert.equal(resolveAcceptLanguageLocale({}), null);
});

void test('oversized cookie headers fall through to saved preferences without partial interpretation', () => {
    const boundary = `locale=fr; other=${'x'.repeat(8175)}`;
    assert.equal(boundary.length, 8192);
    assert.equal(resolveLocaleCookie(boundary), 'fr');
    assert.equal(resolveLocaleCookie(`${boundary}x`), null);
    assert.equal(
        resolveLocale({
            cookieLocale: resolveLocaleCookie(`${boundary}x`),
            savedLocale: 'nl-BE',
            acceptLanguage: 'en',
        }),
        'nl-BE'
    );
});
