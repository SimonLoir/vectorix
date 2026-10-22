import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import MailService from '@repo/emails/mail-service';
import { app } from './app';

type Browser = {
    post(path: string, body: unknown): Promise<unknown>;
    headers(extra?: Record<string, string>): Record<string, string>;
};
type Fixture = {
    createBrowser(): Browser;
    registerUser(id: string): void;
};
const environmentKeys = [
    'VECTORIX_WEB_URL',
    'WEB_URL',
    'APP_URL',
    'VECTORIX_DEFAULT_RESEND_API_KEY',
    'VECTORIX_DEFAULT_SMTP_HOST',
] as const;
const unavailable = {
    code: 'PASSWORD_RESET_UNAVAILABLE',
    message: 'Password reset is temporarily unavailable.',
};

function authRequest(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
) {
    return app.request(`http://localhost:3001/api/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

/** Captures the real rendered message at its delivery boundary; native token and session behavior uses the isolated catalog database. */
export async function passwordResetIntegrationTests(
    t: TestContext,
    f: Fixture
) {
    const previous = new Map(
        environmentKeys.map((key) => [key, process.env[key]])
    );
    const messages: { to: string; subject: string; html: string }[] = [];
    const delivery = t.mock.method(
        MailService.prototype,
        'sendMail',
        (to: string, subject: string, html: string) => {
            messages.push({ to, subject, html });
            return Promise.resolve();
        }
    );
    const run = randomUUID();
    const password = 'Local-test-password-928!';
    const newPassword = 'Changed-test-password-938!';
    const targetEmail = `reset-target-${run}@example.test`;
    const otherEmail = `reset-other-${run}@example.test`;
    const unknownEmail = `reset-unknown-${run}@example.test`;
    const target = f.createBrowser();
    const other = f.createBrowser();
    const secondSession = f.createBrowser();
    const userIds: string[] = [];
    let token = '';
    function configure(value?: string) {
        for (const key of ['VECTORIX_WEB_URL', 'WEB_URL', 'APP_URL'] as const)
            delete process.env[key];
        if (value !== undefined) process.env.VECTORIX_WEB_URL = value;
        process.env.VECTORIX_DEFAULT_RESEND_API_KEY =
            'controlled-test-key-not-used-on-network';
        delete process.env.VECTORIX_DEFAULT_SMTP_HOST;
    }
    function capturedToken() {
        const message = messages.at(-1);
        assert.ok(message);
        assert.equal(message.to, targetEmail);
        const href = /href="([^"]+)"/.exec(message.html)?.[1];
        assert.ok(href);
        let url: URL;
        try {
            url = new URL(href.replaceAll('&amp;', '&'));
        } catch {
            assert.fail('The captured reset link must be a valid URL.');
        }
        assert.equal(url.origin, 'https://canonical.example.test');
        assert.equal(url.pathname, '/deployed/vectorix/reset-password');
        assert.ok(!message.html.includes('attacker.example.test'));
        const value = url.searchParams.get('token');
        assert.ok(value);
        assert.deepEqual([...url.searchParams.keys()], ['token']);
        return value;
    }
    try {
        for (const [email, browser] of [
            [targetEmail, target],
            [otherEmail, other],
        ] as const) {
            await browser.post('sign-up/email', {
                name: 'Password reset fixture',
                email,
                password,
            });
            const user = await prisma.user.findUniqueOrThrow({
                where: { email },
            });
            userIds.push(user.id);
            f.registerUser(user.id);
        }
        await secondSession.post('sign-in/email', {
            email: targetEmail,
            password,
        });

        await t.test(
            'unconfigured and invalid canonical reset URLs return the same sanitized 503 before account lookup side effects',
            async () => {
                for (const value of [
                    undefined,
                    'not-a-canonical-url',
                    'https://canonical.example.test/path\u0007suffix',
                    'https://canonical.example.test/path\u007Fsuffix',
                ]) {
                    configure(value);
                    if (value)
                        process.env.WEB_URL =
                            'https://valid-lower-priority.example.test';
                    const before = await prisma.verification.count();
                    const responses: unknown[] = [];
                    for (const email of [targetEmail, unknownEmail]) {
                        const response = await authRequest(
                            'request-password-reset',
                            { email },
                            {
                                origin: 'https://origin-attacker.example.test',
                                referer:
                                    'https://referer-attacker.example.test/page',
                                host: 'host-attacker.example.test',
                                'x-forwarded-host':
                                    'forwarded-attacker.example.test',
                            }
                        );
                        assert.equal(response.status, 503);
                        responses.push(await response.json());
                    }
                    assert.deepEqual(responses, [unavailable, unavailable]);
                    assert.equal(await prisma.verification.count(), before);
                    assert.equal(messages.length, 0);
                }
            }
        );

        await t.test(
            'a cookie-free hostile origin cannot change the actual reset link and unknown accounts remain indistinguishable',
            async () => {
                configure('https://canonical.example.test/deployed/vectorix');
                const responses: unknown[] = [];
                for (const email of [targetEmail, unknownEmail]) {
                    const response = await authRequest(
                        'request-password-reset',
                        { email },
                        {
                            origin: 'https://origin-attacker.example.test',
                            referer:
                                'https://referer-attacker.example.test/page',
                            host: 'host-attacker.example.test',
                            forwarded:
                                'host=forwarded-attacker.example.test;proto=http',
                            'x-forwarded-host':
                                'forwarded-attacker.example.test',
                            'x-forwarded-proto': 'http',
                            'accept-language': 'en-US,en;q=0.9',
                        }
                    );
                    assert.equal(response.status, 200);
                    responses.push(await response.json());
                }
                assert.deepEqual(responses[0], responses[1]);
                assert.equal(messages.length, 1);
                assert.equal(
                    messages[0]!.subject,
                    'Reset your Vectorix password'
                );
                token = capturedToken();
                const verification = await prisma.verification.findFirst({
                    where: {
                        identifier: `reset-password:${token}`,
                        value: userIds[0],
                    },
                });
                assert.ok(
                    verification,
                    'The captured link must match an issued verification.'
                );
                assert.ok(verification.expiresAt > new Date());
            }
        );

        await t.test(
            'the native reset token changes only its account once and revokes both existing sessions',
            async () => {
                assert.ok(token);
                assert.equal(
                    await prisma.session.count({
                        where: { userId: userIds[0] },
                    }),
                    2
                );
                const response = await authRequest('reset-password', {
                    token,
                    newPassword,
                });
                assert.equal(response.status, 200);
                assert.equal(
                    await prisma.session.count({
                        where: { userId: userIds[0] },
                    }),
                    0
                );
                for (const browser of [target, secondSession]) {
                    const session = await app.request('/api/auth/get-session', {
                        headers: browser.headers(),
                    });
                    assert.equal(session.status, 200);
                    assert.equal(await session.json(), null);
                }
                assert.equal(
                    (
                        await authRequest('reset-password', {
                            token,
                            newPassword: 'Must-not-apply-password-928!',
                        })
                    ).status,
                    400
                );
                assert.equal(
                    (
                        await authRequest('sign-in/email', {
                            email: targetEmail,
                            password,
                        })
                    ).status,
                    401
                );
                assert.equal(
                    (
                        await authRequest('sign-in/email', {
                            email: targetEmail,
                            password: newPassword,
                        })
                    ).status,
                    200
                );
                assert.equal(
                    (
                        await authRequest('sign-in/email', {
                            email: otherEmail,
                            password,
                        })
                    ).status,
                    200
                );
                assert.equal(
                    (
                        await authRequest('sign-in/email', {
                            email: otherEmail,
                            password: newPassword,
                        })
                    ).status,
                    401
                );
            }
        );

        await t.test(
            'an expired native token is consumed without changing the password or revoking a current session',
            async () => {
                const requested = await authRequest('request-password-reset', {
                    email: targetEmail,
                });
                assert.equal(requested.status, 200);
                assert.equal(messages.length, 2);
                const expired = capturedToken();
                assert.ok(
                    expired !== token,
                    'A fresh reset request must issue a distinct token.'
                );
                const verification = await prisma.verification.findFirst({
                    where: {
                        identifier: `reset-password:${expired}`,
                        value: userIds[0],
                    },
                });
                assert.ok(
                    verification,
                    'The expiring token must belong to the test account.'
                );
                // Only this owned row in the runner's disposable _test database is aged; application data is never accepted.
                await prisma.verification.update({
                    where: { id: verification.id },
                    data: { expiresAt: new Date(0) },
                });
                const sessionsBefore = await prisma.session.count({
                    where: { userId: userIds[0] },
                });
                assert.ok(sessionsBefore > 0);
                assert.equal(
                    (
                        await authRequest('reset-password', {
                            token: expired,
                            newPassword: 'Expired-token-password-928!',
                        })
                    ).status,
                    400
                );
                assert.equal(
                    await prisma.session.count({
                        where: { userId: userIds[0] },
                    }),
                    sessionsBefore
                );
                assert.equal(
                    (
                        await authRequest('sign-in/email', {
                            email: targetEmail,
                            password: newPassword,
                        })
                    ).status,
                    200
                );
                assert.equal(
                    (
                        await authRequest('sign-in/email', {
                            email: targetEmail,
                            password: 'Expired-token-password-928!',
                        })
                    ).status,
                    401
                );
            }
        );
    } finally {
        delivery.mock.restore();
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await prisma.verification.deleteMany({
            where: {
                identifier: { startsWith: 'reset-password:' },
                value: { in: userIds },
            },
        });
    }
}
