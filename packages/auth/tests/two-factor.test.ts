import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { onSessionCreated, notifySessionCreated } from '../src/session-created';
import { createTwoFactorPlugin } from '../src/two-factor';
import {
    isChallengeableSignIn,
    signInNotificationPlugin,
} from '../src/sign-in-notification-plugin';

const notifiedSessionIds: string[] = [];
onSessionCreated((session) => {
    notifiedSessionIds.push(session.id);
    return Promise.resolve();
});

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 code for a base32 secret, as an authenticator app computes it. */
function totp(base32Secret: string, now = Date.now()) {
    const bits = [...base32Secret.replace(/=+$/, '').toUpperCase()]
        .map((char) => BASE32.indexOf(char).toString(2).padStart(5, '0'))
        .join('');
    const key = Buffer.from(
        bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2))
    );
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
    const digest = createHmac('sha1', key).update(counter).digest();
    const offset = digest.at(-1)! & 0xf;
    const code = (digest.readUInt32BE(offset) & 0x7f_ff_ff_ff) % 1_000_000;
    return code.toString().padStart(6, '0');
}

function createFixture() {
    const database: MemoryDB = {
        user: [],
        session: [],
        account: [],
        verification: [],
        twoFactor: [],
    };
    const auth = betterAuth({
        baseURL: 'http://localhost:3001',
        secret: 'vectorix-two-factor-tests-secret-at-least-32-characters',
        database: memoryAdapter(database),
        rateLimit: { enabled: false },
        trustedOrigins: ['http://localhost:3000'],
        emailAndPassword: { enabled: true },
        plugins: [createTwoFactorPlugin(), signInNotificationPlugin()],
        databaseHooks: {
            session: {
                create: {
                    after: (session, context) => {
                        if (!isChallengeableSignIn(context?.path)) {
                            void notifySessionCreated(session);
                        }
                        return Promise.resolve();
                    },
                },
            },
        },
    });

    let cookies = new Map<string, string>();
    const request = async (path: string, body: Record<string, unknown>) => {
        const response = await auth.handler(
            new Request(`http://localhost:3001/api/auth${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: 'http://localhost:3000',
                    cookie: [...cookies]
                        .map(([name, value]) => `${name}=${value}`)
                        .join('; '),
                },
                body: JSON.stringify(body),
            })
        );
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';');
            const [name, ...value] = pair!.split('=');
            const cookieValue = value.join('=');
            if (cookieValue === '' || /max-age=0/i.test(header)) {
                cookies.delete(name!);
            } else {
                cookies.set(name!, cookieValue);
            }
        }
        // Let fire-and-forget listeners run.
        await new Promise((resolve) => setImmediate(resolve));
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
        };
    };
    const resetCookies = () => {
        cookies = new Map();
    };
    return { database, request, resetCookies };
}

const credentials = {
    email: 'member@example.com',
    password: 'correct-horse-battery',
};

void test('credential sign-in without 2FA notifies exactly once', async () => {
    const { request, resetCookies } = createFixture();
    await request('/sign-up/email', { ...credentials, name: 'Member' });
    resetCookies();
    notifiedSessionIds.length = 0;

    const signIn = await request('/sign-in/email', credentials);

    assert.equal(signIn.status, 200);
    assert.equal(signIn.body.twoFactorRedirect, undefined);
    assert.equal(notifiedSessionIds.length, 1);
});

void test('enabled 2FA challenges the password and notifies only the verified session', async () => {
    const { database, request, resetCookies } = createFixture();
    await request('/sign-up/email', { ...credentials, name: 'Member' });

    const enabled = await request('/two-factor/enable', {
        password: credentials.password,
    });
    assert.equal(enabled.status, 200);
    assert.equal((enabled.body.backupCodes as string[]).length, 10);
    const secret = new URL(enabled.body.totpURI as string).searchParams.get(
        'secret'
    )!;
    assert.equal(
        (await request('/two-factor/verify-totp', { code: totp(secret) }))
            .status,
        200
    );
    assert.equal(database.user[0]!.twoFactorEnabled, true);

    resetCookies();
    notifiedSessionIds.length = 0;
    const signIn = await request('/sign-in/email', credentials);
    assert.equal(signIn.body.twoFactorRedirect, true);
    assert.deepEqual(signIn.body.twoFactorMethods, ['totp']);
    assert.equal(notifiedSessionIds.length, 0);
    assert.equal(database.session.length, 1, 'pending session was deleted');

    const wrong = await request('/two-factor/verify-totp', { code: '000000' });
    assert.notEqual(wrong.status, 200);

    const verified = await request('/two-factor/verify-totp', {
        code: totp(secret),
        trustDevice: true,
    });
    assert.equal(verified.status, 200);
    assert.equal(notifiedSessionIds.length, 1);
    assert.equal(
        notifiedSessionIds[0],
        database.session.at(-1)!.id,
        'the notified session is the verified one'
    );
});

void test('backup codes are single use and never stored in plain text', async () => {
    const { database, request, resetCookies } = createFixture();
    await request('/sign-up/email', { ...credentials, name: 'Member' });
    const enabled = await request('/two-factor/enable', {
        password: credentials.password,
    });
    const secret = new URL(enabled.body.totpURI as string).searchParams.get(
        'secret'
    )!;
    await request('/two-factor/verify-totp', { code: totp(secret) });
    const [backupCode] = enabled.body.backupCodes as string[];
    assert.ok(
        !String(database.twoFactor[0]!.backupCodes).includes(backupCode!)
    );

    resetCookies();
    await request('/sign-in/email', credentials);
    assert.equal(
        (await request('/two-factor/verify-backup-code', { code: backupCode }))
            .status,
        200
    );

    resetCookies();
    await request('/sign-in/email', credentials);
    assert.notEqual(
        (await request('/two-factor/verify-backup-code', { code: backupCode }))
            .status,
        200
    );
});
