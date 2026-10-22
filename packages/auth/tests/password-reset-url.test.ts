import assert from 'node:assert/strict';
import { test } from 'node:test';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import MailService from '@repo/emails/mail-service';
import { sendPasswordResetEmail } from '../src/password-reset-email';
import {
    assertPasswordResetUrlConfigured,
    buildCanonicalPasswordResetUrl,
} from '../src/password-reset-url';

const unavailable = {
    code: 'PASSWORD_RESET_UNAVAILABLE',
    message: 'Password reset is temporarily unavailable.',
};
const keys = [
    'VECTORIX_WEB_URL',
    'WEB_URL',
    'APP_URL',
    'VECTORIX_DEFAULT_RESEND_API_KEY',
    'VECTORIX_DEFAULT_SMTP_HOST',
] as const;

async function withEnvironment(
    values: Partial<Record<(typeof keys)[number], string>>,
    run: () => Promise<void>
) {
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) {
        if (values[key] === undefined) delete process.env[key];
        else process.env[key] = values[key];
    }
    try {
        await run();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function assertUnavailable(error: unknown) {
    assert.ok(error && typeof error === 'object' && 'body' in error);
    assert.deepEqual(error.body, unavailable);
    return true;
}

void test('canonical reset URLs use the first nonempty configured value and preserve its deployment prefix', () => {
    assert.equal(
        buildCanonicalPasswordResetUrl('token', {
            VECTORIX_WEB_URL: ' https://web.example.test/platform/ ',
            WEB_URL: 'https://lower-priority.example.test',
            APP_URL: 'https://last.example.test',
        }),
        'https://web.example.test/platform/reset-password?token=token'
    );
    assert.equal(
        buildCanonicalPasswordResetUrl('token', {
            VECTORIX_WEB_URL: ' ',
            WEB_URL: 'https://web.example.test/base',
            APP_URL: 'https://last.example.test',
        }),
        'https://web.example.test/base/reset-password?token=token'
    );
    assert.equal(
        buildCanonicalPasswordResetUrl('token', {
            APP_URL: 'http://localhost:3000/local/',
        }),
        'http://localhost:3000/local/reset-password?token=token'
    );
    assert.doesNotThrow(() =>
        assertPasswordResetUrlConfigured({
            WEB_URL: 'https://configured.example.test',
        })
    );
});

void test('missing or invalid selected configuration fails closed without falling back to a lower-priority URL', () => {
    assert.throws(
        () => buildCanonicalPasswordResetUrl('token', {}),
        assertUnavailable
    );
    assert.throws(
        () =>
            assertPasswordResetUrlConfigured({
                VECTORIX_WEB_URL: ' ',
                WEB_URL: '\t',
            }),
        assertUnavailable
    );
    for (const value of [
        'not-a-url',
        '/relative',
        '//attacker.example.test',
        'ftp://web.example.test',
        'javascript:alert(1)',
        'https://user:password@web.example.test',
        'https://user@web.example.test',
        'https://web.example.test/?redirect=attacker',
        'https://web.example.test/#fragment',
        'https://web.example.test/path?',
        'https://web.example.test/path#',
        'https://@web.example.test',
        'https:web.example.test',
        String.raw`https:\\web.example.test`,
        'https://web.example.test/path\tprefix',
        'https://web.example.test/path\u0000prefix',
        'https://web.example.test/path\u0007prefix',
        'https://web.example.test/path\u007Fprefix',
        'https://web.example.test/path\u0000',
    ]) {
        const environment = {
            VECTORIX_WEB_URL: value,
            WEB_URL: 'https://valid-lower.example.test',
            APP_URL: 'https://valid-last.example.test',
        };
        assert.throws(
            () => buildCanonicalPasswordResetUrl('token', environment),
            assertUnavailable,
            value
        );
        assert.throws(
            () => assertPasswordResetUrlConfigured(environment),
            assertUnavailable,
            value
        );
    }
});

void test('reset tokens are encoded exactly once as query data and never change the destination', () => {
    const token = 'a+b /?&=#%é🙂';
    const result = new URL(
        buildCanonicalPasswordResetUrl(token, {
            VECTORIX_WEB_URL: 'https://web.example.test/deployed/app',
        })
    );
    assert.equal(result.origin, 'https://web.example.test');
    assert.equal(result.pathname, '/deployed/app/reset-password');
    assert.equal(result.searchParams.get('token'), token);
    assert.deepEqual([...result.searchParams.keys()], ['token']);
    assert.equal(result.hash, '');
});

void test('the email callback rechecks canonical configuration before credentials or any mail delivery', async (t) => {
    const mail = t.mock.method(MailService.prototype, 'sendMail', () =>
        Promise.resolve()
    );
    for (const values of [
        {},
        {
            VECTORIX_WEB_URL: 'https://user:private@invalid.example.test',
            WEB_URL: 'https://fallback.example.test',
        },
    ]) {
        await withEnvironment(values, async () => {
            await assert.rejects(
                sendPasswordResetEmail({
                    user: { email: 'known@example.test' },
                    token: 'private-reset-token',
                    request: new Request(
                        'https://forged-host.example.test/api/auth/request-password-reset',
                        {
                            headers: {
                                origin: 'https://origin-attacker.example.test',
                                referer:
                                    'https://referer-attacker.example.test/path',
                                host: 'host-attacker.example.test',
                                'x-forwarded-host':
                                    'forwarded-attacker.example.test',
                            },
                        }
                    ),
                }),
                assertUnavailable
            );
        });
    }
    assert.equal(mail.mock.callCount(), 0);
});

void test('rendered callback links ignore all request origins while locale still controls email wording', async (t) => {
    const messages: { subject: string; html: string }[] = [];
    t.mock.method(
        MailService.prototype,
        'sendMail',
        (_to: string, subject: string, html: string) => {
            messages.push({ subject, html });
            return Promise.resolve();
        }
    );
    await withEnvironment(
        {
            VECTORIX_WEB_URL: 'https://canonical.example.test/prefix',
            VECTORIX_DEFAULT_RESEND_API_KEY:
                'controlled-test-key-not-used-on-network',
        },
        async () => {
            for (const locale of ['en', 'fr', 'nl-BE']) {
                await sendPasswordResetEmail({
                    user: { email: 'known@example.test', name: '<unsafe>' },
                    token: 'a+b /?&=#%',
                    request: new Request(
                        'http://host-attacker.example.test/api/auth/request-password-reset',
                        {
                            headers: {
                                origin: 'https://origin-attacker.example.test',
                                referer:
                                    'https://referer-attacker.example.test/path',
                                host: 'host-attacker.example.test',
                                forwarded:
                                    'host=forwarded-attacker.example.test;proto=http',
                                'x-forwarded-host':
                                    'forwarded-attacker.example.test',
                                cookie: `locale=${locale}`,
                            },
                        }
                    ),
                });
            }
        }
    );
    assert.equal(messages.length, 3);
    assert.equal(new Set(messages.map((message) => message.subject)).size, 3);
    for (const { html } of messages) {
        const href = /href="([^"]+)"/.exec(html)?.[1];
        assert.ok(href);
        const url = new URL(href.replaceAll('&amp;', '&'));
        assert.equal(url.origin, 'https://canonical.example.test');
        assert.equal(url.pathname, '/prefix/reset-password');
        assert.equal(url.searchParams.get('token'), 'a+b /?&=#%');
        assert.ok(!html.includes('attacker.example.test'));
        assert.ok(!html.includes('<unsafe>'));
    }
});

void test('the installed native flow rejects known and unknown accounts identically before token creation', async (t) => {
    const database = {
        user: [],
        account: [],
        session: [],
        verification: [],
    } satisfies MemoryDB;
    const mail = t.mock.method(MailService.prototype, 'sendMail', () =>
        Promise.resolve()
    );
    const auth = betterAuth({
        baseURL: 'http://localhost:3001',
        secret: 'password-reset-tests-secret-at-least-32-characters',
        database: memoryAdapter(database),
        rateLimit: { enabled: false },
        hooks: {
            before: createAuthMiddleware((context) => {
                if (context.path === '/request-password-reset')
                    assertPasswordResetUrlConfigured();
                return Promise.resolve();
            }),
        },
        emailAndPassword: {
            enabled: true,
            sendResetPassword: ({ user, token }, request) =>
                sendPasswordResetEmail({ user, token, request }),
        },
    });
    const signup = await auth.handler(
        new Request('http://localhost:3001/api/auth/sign-up/email', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                email: 'known@example.test',
                name: 'Known',
                password: 'Local-test-password-928!',
            }),
        })
    );
    assert.equal(signup.status, 200);
    for (const values of [
        {},
        {
            VECTORIX_WEB_URL: 'invalid-canonical',
            WEB_URL: 'https://valid-fallback.example.test',
        },
    ]) {
        await withEnvironment(values, async () => {
            const before = database.verification.length;
            const responses: unknown[] = [];
            for (const email of [
                'known@example.test',
                'unknown@example.test',
            ]) {
                const response = await auth.handler(
                    new Request(
                        'http://localhost:3001/api/auth/request-password-reset',
                        {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                origin: 'https://attacker.example.test',
                            },
                            body: JSON.stringify({ email }),
                        }
                    )
                );
                assert.equal(response.status, 503);
                responses.push(await response.json());
            }
            assert.deepEqual(responses, [unavailable, unavailable]);
            assert.equal(database.verification.length, before);
            assert.equal(mail.mock.callCount(), 0);
        });
    }
});
