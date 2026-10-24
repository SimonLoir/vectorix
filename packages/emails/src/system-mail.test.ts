import assert from 'node:assert/strict';
import { test } from 'node:test';
import MailService from './MailService';
import {
    assertSystemMailConfigured,
    resolveSystemMailConfiguration,
    SystemMailError,
    type SystemMailEnvironment,
} from './system-mail-configuration';
import { sendSystemMail } from './system-mail';

const environmentKeys = [
    'VECTORIX_DEFAULT_RESEND_API_KEY',
    'VECTORIX_DEFAULT_RESEND_SENDER_EMAIL',
    'VECTORIX_DEFAULT_SMTP_HOST',
    'VECTORIX_DEFAULT_SMTP_PORT',
    'VECTORIX_DEFAULT_SMTP_USER',
    'VECTORIX_DEFAULT_SMTP_PASSWORD',
    'VECTORIX_DEFAULT_SMTP_SENDER_EMAIL',
] as const;

async function withEnvironment(
    values: SystemMailEnvironment,
    run: () => Promise<void>
) {
    const previous = new Map(
        environmentKeys.map((key) => [key, process.env[key]])
    );
    for (const key of environmentKeys) {
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

void test('Resend is authoritative, preserves its secret and cannot borrow the SMTP sender', () => {
    assert.deepEqual(
        resolveSystemMailConfiguration({
            VECTORIX_DEFAULT_RESEND_API_KEY: ' selected-test-secret ',
            VECTORIX_DEFAULT_RESEND_SENDER_EMAIL:
                ' resend-sender@example.test ',
            VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
            VECTORIX_DEFAULT_SMTP_PORT: 'invalid-ignored-port',
            VECTORIX_DEFAULT_SMTP_SENDER_EMAIL: 'smtp-sender@example.test',
        }),
        {
            provider: 'resend',
            apiKey: ' selected-test-secret ',
            senderEmail: 'resend-sender@example.test',
        }
    );
    assert.throws(
        () =>
            resolveSystemMailConfiguration({
                VECTORIX_DEFAULT_RESEND_API_KEY: '   ',
                VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
            }),
        { code: 'SYSTEM_MAIL_INVALID_CONFIGURATION' }
    );
    assert.equal(
        resolveSystemMailConfiguration({
            VECTORIX_DEFAULT_RESEND_API_KEY: 'test-secret',
            VECTORIX_DEFAULT_SMTP_SENDER_EMAIL: 'smtp-sender@example.test',
        }).senderEmail,
        'noreply@example.com'
    );
});

void test('SMTP supports an unauthenticated relay and its own sender with the shared default port', () => {
    const environment = {
        VECTORIX_DEFAULT_SMTP_HOST: ' smtp.example.test ',
        VECTORIX_DEFAULT_RESEND_SENDER_EMAIL: 'unused@example.test',
        VECTORIX_DEFAULT_SMTP_SENDER_EMAIL: 'smtp-sender@example.test',
    };
    assert.doesNotThrow(() => assertSystemMailConfigured(environment));
    assert.deepEqual(resolveSystemMailConfiguration(environment), {
        provider: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        senderEmail: 'smtp-sender@example.test',
    });
    assert.equal(
        resolveSystemMailConfiguration({
            VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
            VECTORIX_DEFAULT_RESEND_SENDER_EMAIL: 'unused@example.test',
            VECTORIX_DEFAULT_SMTP_SENDER_EMAIL: ' ',
        }).senderEmail,
        'noreply@example.com'
    );
});

void test('SMTP preserves raw authentication bytes and rejects partial authentication', () => {
    assert.deepEqual(
        resolveSystemMailConfiguration({
            VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
            VECTORIX_DEFAULT_SMTP_PORT: '0465',
            VECTORIX_DEFAULT_SMTP_USER: ' user@example.test ',
            VECTORIX_DEFAULT_SMTP_PASSWORD: '  password+%é  ',
        }),
        {
            provider: 'smtp',
            host: 'smtp.example.test',
            port: 465,
            auth: {
                user: ' user@example.test ',
                pass: '  password+%é  ',
            },
            senderEmail: 'noreply@example.com',
        }
    );
    for (const credentials of [
        { VECTORIX_DEFAULT_SMTP_USER: 'user' },
        { VECTORIX_DEFAULT_SMTP_PASSWORD: 'password' },
        {
            VECTORIX_DEFAULT_SMTP_USER: 'user',
            VECTORIX_DEFAULT_SMTP_PASSWORD: '',
        },
        {
            VECTORIX_DEFAULT_SMTP_USER: ' ',
            VECTORIX_DEFAULT_SMTP_PASSWORD: 'password',
        },
    ]) {
        assert.throws(
            () =>
                resolveSystemMailConfiguration({
                    VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
                    ...credentials,
                }),
            { code: 'SYSTEM_MAIL_INVALID_CONFIGURATION' }
        );
    }
});

void test('SMTP ports are integer network ports and configured sender controls are refused', () => {
    for (const port of ['0', '-1', '1.5', '65536', '1e3', '0x19', 'NaN']) {
        assert.throws(
            () =>
                resolveSystemMailConfiguration({
                    VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
                    VECTORIX_DEFAULT_SMTP_PORT: port,
                }),
            { code: 'SYSTEM_MAIL_INVALID_CONFIGURATION' }
        );
    }
    for (const port of ['1', '65535']) {
        assert.doesNotThrow(() =>
            assertSystemMailConfigured({
                VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
                VECTORIX_DEFAULT_SMTP_PORT: port,
            })
        );
    }
    assert.throws(
        () =>
            assertSystemMailConfigured({
                VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
                VECTORIX_DEFAULT_SMTP_SENDER_EMAIL:
                    'sender@example.test\r\nBcc: other@example.test',
            }),
        { code: 'SYSTEM_MAIL_INVALID_CONFIGURATION' }
    );
});

void test('preflight and delivery use the same configuration and never dispatch invalid configuration', async (t) => {
    const delivery = t.mock.method(MailService.prototype, 'sendMail', () =>
        Promise.resolve()
    );
    await withEnvironment(
        {
            VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
            VECTORIX_DEFAULT_SMTP_USER: 'incomplete-user',
        },
        async () => {
            assert.throws(() => assertSystemMailConfigured(), {
                code: 'SYSTEM_MAIL_INVALID_CONFIGURATION',
            });
            await assert.rejects(
                sendSystemMail(
                    'recipient@example.test',
                    'Subject',
                    '<p>Test</p>'
                ),
                { code: 'SYSTEM_MAIL_INVALID_CONFIGURATION' }
            );
        }
    );
    assert.equal(delivery.mock.callCount(), 0);
    await withEnvironment({}, async () => {
        assert.throws(() => assertSystemMailConfigured(), {
            code: 'SYSTEM_MAIL_NOT_CONFIGURED',
        });
        await assert.rejects(
            sendSystemMail('recipient@example.test', 'Subject', '<p>Test</p>'),
            { code: 'SYSTEM_MAIL_NOT_CONFIGURED' }
        );
    });
    assert.equal(delivery.mock.callCount(), 0);
});

void test('delivery uses the chosen sender once and sanitizes failures without SMTP fallback', async (t) => {
    const sent: string[] = [];
    const rawFailure = 'synthetic-provider-secret recipient@example.test';
    const delivery = t.mock.method(
        MailService.prototype,
        'sendMail',
        (
            _to: string,
            _subject: string,
            _html: string,
            from: string | undefined = ''
        ) => {
            sent.push(from ?? '');
            return Promise.reject(new Error(rawFailure));
        }
    );
    await withEnvironment(
        {
            VECTORIX_DEFAULT_RESEND_API_KEY: 'selected-test-secret',
            VECTORIX_DEFAULT_RESEND_SENDER_EMAIL: 'resend@example.test',
            VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
            VECTORIX_DEFAULT_SMTP_SENDER_EMAIL: 'smtp@example.test',
        },
        async () => {
            assert.doesNotThrow(() => assertSystemMailConfigured());
            await assert.rejects(
                sendSystemMail(
                    'recipient@example.test',
                    'Subject',
                    '<p>Test</p>'
                ),
                (error: unknown) => {
                    assert.ok(error instanceof SystemMailError);
                    assert.equal(error.code, 'SYSTEM_MAIL_DELIVERY_FAILED');
                    assert.equal(
                        error.message,
                        'System email delivery failed.'
                    );
                    assert.equal(error.cause, undefined);
                    assert.ok(!String(error.stack).includes(rawFailure));
                    return true;
                }
            );
        }
    );
    assert.equal(delivery.mock.callCount(), 1);
    assert.deepEqual(sent, ['resend@example.test']);
});

void test('successful unauthenticated SMTP delivery uses its sender rather than the configured Resend sender', async (t) => {
    const sent: { to: string; from: string | undefined }[] = [];
    const delivery = t.mock.method(
        MailService.prototype,
        'sendMail',
        (to: string, _subject: string, _html: string, from?: string) => {
            sent.push({ to, from });
            return Promise.resolve();
        }
    );
    await withEnvironment(
        {
            VECTORIX_DEFAULT_SMTP_HOST: 'smtp.example.test',
            VECTORIX_DEFAULT_SMTP_SENDER_EMAIL: 'smtp@example.test',
            VECTORIX_DEFAULT_RESEND_SENDER_EMAIL: 'unused@example.test',
        },
        async () => {
            assert.doesNotThrow(() => assertSystemMailConfigured());
            await sendSystemMail(
                'recipient@example.test',
                'Subject',
                '<p>Test</p>'
            );
        }
    );
    assert.equal(delivery.mock.callCount(), 1);
    assert.deepEqual(sent, [
        { to: 'recipient@example.test', from: 'smtp@example.test' },
    ]);
});
