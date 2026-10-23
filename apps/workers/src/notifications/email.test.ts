import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountSignInMessages } from '@routers/utils/notifications';
import { renderAccountSignInEmail } from './email';

void test('notification languages share regional normalization and English fallback', () => {
    for (const [savedLocale, locale, title, action] of [
        ['en-US', 'en', 'New sign-in to your account', 'Open my account'],
        ['en-GB', 'en', 'New sign-in to your account', 'Open my account'],
        [
            'fr-CA',
            'fr',
            'Nouvelle connexion à votre compte',
            'Ouvrir mon compte',
        ],
        [
            'nl-NL',
            'nl-BE',
            'Nieuwe aanmelding op uw account',
            'Mijn account openen',
        ],
        [null, 'en', 'New sign-in to your account', 'Open my account'],
        ['unsupported', 'en', 'New sign-in to your account', 'Open my account'],
    ] as const) {
        const resolved = accountSignInMessages(savedLocale);
        assert.equal(resolved.locale, locale);
        assert.equal(resolved.title, title);
        const rendered = renderAccountSignInEmail({
            savedLocale,
            title: 'Historical title',
            body: 'Frozen device and source facts',
            accountUrl: 'https://vectorix.example.test/dashboard/account',
        });
        assert.equal(rendered.subject, title);
        assert.ok(rendered.html.includes(`lang="${locale}"`));
        assert.ok(rendered.html.includes(action));
        assert.ok(rendered.html.includes('Frozen device and source facts'));
        assert.ok(!rendered.html.includes('Historical title'));
    }
});

void test('notification email escapes facts and href and omits historical fallback title', () => {
    const message = renderAccountSignInEmail({
        savedLocale: 'en',
        title: 'Historical title',
        body: '<img src=x onerror="bad()"> & account',
        accountUrl: 'https://vectorix.example.test/?a=1&b="x"',
    });
    assert.ok(!message.html.includes('<img'));
    assert.ok(message.html.includes('&lt;img'));
    assert.ok(message.html.includes('&amp;b=&quot;x&quot;'));
    const fallback = renderAccountSignInEmail({
        savedLocale: 'nl-BE',
        title: 'Nouvelle connexion à votre compte',
        body: 'Nouvelle connexion à votre compte',
        accountUrl: 'https://vectorix.example.test/',
    });
    assert.ok(!fallback.html.includes('Nouvelle connexion'));
    assert.ok(fallback.html.includes('Mijn account openen'));
});
