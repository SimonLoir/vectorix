import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createEmailVerificationToken } from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';
import { auth } from '@repo/auth';
import { prisma } from '@repo/db';
import { Pool } from 'pg';
import { z } from 'zod';
import { app } from './app';
import { htmlPart, smtpCapture } from './email-ownership-tests/smtp';
import { totp } from './email-ownership-tests/totp';

type Fixture = {
    registerUser(id: string): void;
    registerOrganization(id: string): void;
};
const record = z.record(z.string(), z.unknown());
const identity = z.object({ id: z.string() });
const ownershipClaims = z.object({
    email: z.string(),
    updateTo: z.string().optional(),
    requestType: z
        .enum(['change-email-confirmation', 'change-email-verification'])
        .optional(),
    userId: z.string(),
    vectorixEmailOwnership: z.literal(1),
    returnTo: z.string(),
    exp: z.number().int(),
});
const environmentKeys = [
    'VECTORIX_WEB_URL',
    'WEB_URL',
    'APP_URL',
    'VECTORIX_DEFAULT_RESEND_API_KEY',
    'VECTORIX_DEFAULT_RESEND_SENDER_EMAIL',
    'VECTORIX_DEFAULT_SMTP_HOST',
    'VECTORIX_DEFAULT_SMTP_PORT',
    'VECTORIX_DEFAULT_SMTP_USER',
    'VECTORIX_DEFAULT_SMTP_PASSWORD',
    'VECTORIX_DEFAULT_SMTP_SENDER_EMAIL',
] as const;
const origin = 'http://localhost:3000';
const password = 'Email-ownership-test-password-928!';

/** A real native HTTP cookie jar; rejected requests also process cookie expiry. */
function browser() {
    const cookies = new Map<string, string>();
    const headers = () => ({
        origin,
        cookie: [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join('; '),
    });
    async function request(path: string, body?: unknown) {
        const response = await app.request(
            `http://localhost:3001/api/auth/${path}`,
            {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                    ...headers(),
                    ...(body === undefined
                        ? {}
                        : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }
        );
        for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';')[0]!;
            const separator = pair.indexOf('=');
            const name = pair.slice(0, separator);
            const value = pair.slice(separator + 1);
            if (!value || /max-age=0(?:;|$)/i.test(header))
                cookies.delete(name);
            else cookies.set(name, value);
        }
        // Existing native permission hooks may return a bodyless 403. Keep
        // nonempty JSON strict so malformed payloads still fail the fixture.
        const text = await response.text();
        let payload: unknown = null;
        if (text !== '') {
            try {
                payload = JSON.parse(text);
            } catch {
                throw new Error(
                    'The native HTTP fixture received malformed JSON.'
                );
            }
        }
        return { response, body: payload };
    }
    return { request };
}
type Browser = ReturnType<typeof browser>;
type Account = { id: string; email: string; browser: Browser };

function success(result: Awaited<ReturnType<Browser['request']>>) {
    assert.equal(result.response.status, 200);
    return record.parse(result.body);
}

function denied(
    result: Awaited<ReturnType<Browser['request']>>,
    status: number,
    code: string
) {
    assert.equal(result.response.status, status);
    assert.equal(z.object({ code: z.string() }).parse(result.body).code, code);
}

/**
 * Native HTTP/account/mail integration against the catalog's isolated database.
 * Each account and organization is registered with the existing owned cleanup.
 */
export async function emailOwnershipIntegrationTests(
    t: TestContext,
    f: Fixture
) {
    const connectionString = process.env.DATABASE_URL;
    assert.ok(
        connectionString && new URL(connectionString).pathname.endsWith('_test')
    );
    const previous = new Map(
        environmentKeys.map((key) => [key, process.env[key]])
    );
    const secret = (await auth.$context).secret;
    const smtp = await smtpCapture();
    const database = new Pool({ connectionString });
    const run = randomUUID().slice(0, 8);
    let sequence = 0;
    const ownedUsers: string[] = [];
    const ownedOrganizations: string[] = [];
    function configure() {
        process.env.VECTORIX_WEB_URL = origin;
        delete process.env.WEB_URL;
        delete process.env.APP_URL;
        delete process.env.VECTORIX_DEFAULT_RESEND_API_KEY;
        process.env.VECTORIX_DEFAULT_SMTP_HOST = '127.0.0.1';
        process.env.VECTORIX_DEFAULT_SMTP_PORT = String(smtp.port);
        process.env.VECTORIX_DEFAULT_SMTP_USER = 'controlled-smtp';
        process.env.VECTORIX_DEFAULT_SMTP_PASSWORD = 'controlled-test-password';
        process.env.VECTORIX_DEFAULT_SMTP_SENDER_EMAIL =
            'ownership@example.test';
    }
    async function account(label: string): Promise<Account> {
        const email = `ownership-${run}-${++sequence}-${label}@example.test`;
        const session = browser();
        const result = success(
            await session.request('sign-up/email', {
                email,
                password,
                name: `Email ownership ${label}`,
            })
        );
        const { id } = identity.parse(result.user);
        f.registerUser(id);
        ownedUsers.push(id);
        return { id, email, browser: session };
    }
    async function organization(owner: Account, label: string) {
        const result = success(
            await owner.browser.request('organization/create', {
                name: `Ownership ${label}`,
                slug: `ownership-${run}-${++sequence}`,
            })
        );
        const { id } = identity.parse(result);
        f.registerOrganization(id);
        ownedOrganizations.push(id);
        return id;
    }
    async function snapshot() {
        const [users, sessions, members, invitations] = await Promise.all([
            prisma.user.findMany({
                where: { id: { in: ownedUsers } },
                select: {
                    id: true,
                    email: true,
                    emailVerified: true,
                    twoFactorEnabled: true,
                },
                orderBy: { id: 'asc' },
            }),
            prisma.session.findMany({
                where: { userId: { in: ownedUsers } },
                select: { id: true, userId: true, activeOrganizationId: true },
                orderBy: { id: 'asc' },
            }),
            prisma.member.findMany({
                where: { organizationId: { in: ownedOrganizations } },
                select: {
                    id: true,
                    userId: true,
                    organizationId: true,
                    role: true,
                },
                orderBy: { id: 'asc' },
            }),
            prisma.invitation.findMany({
                where: { organizationId: { in: ownedOrganizations } },
                select: {
                    id: true,
                    email: true,
                    status: true,
                    role: true,
                    organizationId: true,
                },
                orderBy: { id: 'asc' },
            }),
        ]);
        return {
            users,
            sessions,
            members,
            invitations,
            messages: smtp.messages.length,
        };
    }
    async function mailedToken(before: number, to: string) {
        const deadline = Date.now() + 2000;
        while (smtp.messages.length === before && Date.now() < deadline)
            await delay(10);
        assert.equal(
            smtp.messages.length,
            before + 1,
            'Exactly one controlled mail must be delivered.'
        );
        const message = smtp.messages[before]!;
        assert.equal(message.to, to);
        const html = htmlPart(message.raw);
        const links = [...html.matchAll(/href="([^"]+)"/g)]
            .map((match) => new URL(match[1]!.replaceAll('&amp;', '&')))
            .filter((url) => url.pathname === '/verify-email');
        assert.equal(
            links.length,
            1,
            'The message must contain one canonical verification link.'
        );
        const url = links[0]!;
        assert.equal(url.origin, origin);
        const token = url.searchParams.get('token');
        assert.ok(token);
        const claims = ownershipClaims.parse(await verifyJWT(token, secret));
        assert.ok(claims.exp > Date.now() / 1000);
        return { token, claims };
    }
    const redeem = (session: Browser, token: string) =>
        session.request(`verify-email?token=${encodeURIComponent(token)}`);
    async function requestVerification(target: Account, returnTo?: string) {
        const before = smtp.messages.length;
        success(
            await target.browser.request('send-verification-email', {
                email: target.email,
                ...(returnTo ? { callbackURL: returnTo } : {}),
            })
        );
        const result = await mailedToken(before, target.email);
        assert.equal(result.claims.userId, target.id);
        assert.equal(result.claims.email, target.email);
        assert.equal(result.claims.updateTo, undefined);
        return result;
    }
    async function invite(
        owner: Account,
        organizationId: string,
        email: string,
        role = 'member'
    ) {
        const result = success(
            await owner.browser.request('organization/invite-member', {
                organizationId,
                email,
                role,
            })
        );
        return identity.parse(result).id;
    }
    try {
        configure();
        await t.test(
            'legacy unverified sign-in and existing organization membership remain usable',
            async () => {
                const target = await account('legacy');
                const organizationId = await organization(target, 'legacy');
                const signedIn = browser();
                success(
                    await signedIn.request('sign-in/email', {
                        email: target.email,
                        password,
                    })
                );
                const session = success(await signedIn.request('get-session'));
                assert.equal(identity.parse(session.user).id, target.id);
                assert.equal(
                    z.object({ emailVerified: z.boolean() }).parse(session.user)
                        .emailVerified,
                    false
                );
                const listed = success(
                    await signedIn.request(
                        'organization/get-full-organization?organizationId=' +
                            organizationId
                    )
                );
                assert.equal(identity.parse(listed).id, organizationId);
                assert.equal(
                    await prisma.member.count({
                        where: { userId: target.id, organizationId },
                    }),
                    1
                );
            }
        );

        await t.test(
            'resend requires the current authoritative matching account and makes no mail or state on denial',
            async () => {
                const target = await account('resend');
                const foreign = await account('resend-foreign');
                const before = await snapshot();
                denied(
                    await browser().request('send-verification-email', {
                        email: target.email,
                    }),
                    401,
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
                denied(
                    await foreign.browser.request('send-verification-email', {
                        email: target.email,
                    }),
                    400,
                    'EMAIL_VERIFICATION_EMAIL_MISMATCH'
                );
                assert.deepEqual(await snapshot(), before);
                const proof = await requestVerification(target);
                const unchanged = await snapshot();
                denied(
                    await redeem(browser(), proof.token),
                    401,
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
                denied(
                    await redeem(foreign.browser, proof.token),
                    403,
                    'EMAIL_VERIFICATION_ACCOUNT_MISMATCH'
                );
                assert.deepEqual(await snapshot(), unchanged);
                const result = success(
                    await redeem(target.browser, proof.token)
                );
                assert.equal(result.outcome, 'ADDRESS_VERIFIED');
                const user = await prisma.user.findUniqueOrThrow({
                    where: { id: target.id },
                });
                assert.equal(user.email, target.email);
                assert.equal(user.emailVerified, true);
                assert.deepEqual(
                    (await snapshot()).sessions,
                    unchanged.sessions
                );
            }
        );

        await t.test(
            'a revoked but still-cookied session cannot request or redeem verification',
            async () => {
                const target = await account('revoked');
                const proof = await requestVerification(target);
                await prisma.session.deleteMany({
                    where: { userId: target.id },
                });
                const before = await snapshot();
                denied(
                    await redeem(target.browser, proof.token),
                    401,
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
                denied(
                    await target.browser.request('send-verification-email', {
                        email: target.email,
                    }),
                    401,
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
                assert.deepEqual(await snapshot(), before);
            }
        );

        await t.test(
            'missing mail or invalid canonical configuration refuses account-security actions without disabling ordinary sessions',
            async () => {
                const target = await account('unavailable');
                const currentProof = await requestVerification(target);
                success(await redeem(target.browser, currentProof.token));
                for (const invalid of ['mail', 'canonical']) {
                    configure();
                    if (invalid === 'mail')
                        delete process.env.VECTORIX_DEFAULT_SMTP_HOST;
                    else process.env.VECTORIX_WEB_URL = 'not-a-canonical-url';
                    const before = await snapshot();
                    try {
                        denied(
                            await target.browser.request(
                                'send-verification-email',
                                { email: target.email }
                            ),
                            503,
                            'EMAIL_VERIFICATION_UNAVAILABLE'
                        );
                        denied(
                            await target.browser.request('change-email', {
                                newEmail: `ownership-${run}-unavailable@example.test`,
                            }),
                            503,
                            'EMAIL_VERIFICATION_UNAVAILABLE'
                        );
                        assert.deepEqual(await snapshot(), before);
                        const session = success(
                            await target.browser.request('get-session')
                        );
                        assert.equal(
                            identity.parse(session.user).id,
                            target.id
                        );
                    } finally {
                        configure();
                    }
                }
            }
        );

        await t.test(
            'a valid session for an unverified current address cannot request an email change or trigger mail callbacks',
            async () => {
                const target = await account('unverified-change');
                const destination = `ownership-${run}-${++sequence}-destination@example.test`;
                // Explicitly synthesize a formerly issuable bound direct-new
                // proof. Tightened redemption must reject it independently of
                // the new request guard; no delivered proof is manufactured.
                const legacyDirect = await createEmailVerificationToken(
                    secret,
                    target.email,
                    destination,
                    3600,
                    {
                        requestType: 'change-email-verification',
                        userId: target.id,
                        vectorixEmailOwnership: 1,
                        returnTo: '/dashboard/account',
                    }
                );
                const beforeLegacy = await snapshot();
                denied(
                    await redeem(target.browser, legacyDirect),
                    403,
                    'EMAIL_VERIFICATION_CURRENT_ADDRESS_REQUIRED'
                );
                assert.deepEqual(await snapshot(), beforeLegacy);
                // The framework rejects an external callback at its router
                // boundary before the account-specific ownership hook runs.
                const beforeHostile = await snapshot();
                denied(
                    await target.browser.request('change-email', {
                        newEmail: destination,
                        callbackURL: 'https://attacker.example.test/untrusted',
                    }),
                    403,
                    'INVALID_CALLBACK_URL'
                );
                assert.deepEqual(await snapshot(), beforeHostile);
                // Possession of a still-valid session is insufficient: the same
                // admission boundary also applies to a stolen session cookie.
                for (const configured of [true, false]) {
                    configure();
                    if (!configured)
                        delete process.env.VECTORIX_DEFAULT_SMTP_HOST;
                    const before = await snapshot();
                    try {
                        denied(
                            await target.browser.request('change-email', {
                                newEmail: destination,
                                callbackURL: '/dashboard/account',
                            }),
                            403,
                            'EMAIL_VERIFICATION_CURRENT_ADDRESS_REQUIRED'
                        );
                        assert.deepEqual(await snapshot(), before);
                        const session = success(
                            await target.browser.request('get-session')
                        );
                        assert.equal(
                            identity.parse(session.user).id,
                            target.id
                        );
                        assert.equal(
                            z
                                .object({ emailVerified: z.boolean() })
                                .parse(session.user).emailVerified,
                            false
                        );
                    } finally {
                        configure();
                    }
                }
            }
        );

        await t.test(
            'verified old-address confirmation and new-address proof both require the same current account',
            async () => {
                const target = await account('two-step');
                const initial = await requestVerification(target);
                success(await redeem(target.browser, initial.token));
                const foreign = await account('two-step-foreign');
                const destination = `ownership-${run}-${++sequence}-confirmed@example.test`;
                const before = smtp.messages.length;
                success(
                    await target.browser.request('change-email', {
                        newEmail: destination,
                    })
                );
                const confirmation = await mailedToken(before, target.email);
                assert.equal(
                    confirmation.claims.requestType,
                    'change-email-confirmation'
                );
                assert.equal(confirmation.claims.userId, target.id);
                const unchanged = await snapshot();
                denied(
                    await redeem(browser(), confirmation.token),
                    401,
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
                denied(
                    await redeem(foreign.browser, confirmation.token),
                    403,
                    'EMAIL_VERIFICATION_ACCOUNT_MISMATCH'
                );
                assert.deepEqual(await snapshot(), unchanged);
                const result = success(
                    await redeem(target.browser, confirmation.token)
                );
                assert.equal(
                    result.outcome,
                    'NEW_ADDRESS_VERIFICATION_REQUIRED'
                );
                const proof = await mailedToken(before + 1, destination);
                assert.equal(
                    proof.claims.requestType,
                    'change-email-verification'
                );
                assert.equal(
                    proof.claims.userId,
                    target.id,
                    'The second native-format token must retain immutable identity.'
                );
                assert.equal(
                    (
                        await prisma.user.findUniqueOrThrow({
                            where: { id: target.id },
                        })
                    ).email,
                    target.email
                );
                const beforeFinal = await snapshot();
                denied(
                    await redeem(browser(), proof.token),
                    401,
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
                denied(
                    await redeem(foreign.browser, proof.token),
                    403,
                    'EMAIL_VERIFICATION_ACCOUNT_MISMATCH'
                );
                assert.deepEqual(await snapshot(), beforeFinal);
                assert.equal(
                    success(await redeem(target.browser, proof.token)).outcome,
                    'ADDRESS_CHANGED'
                );
                assert.deepEqual(
                    (await snapshot()).sessions,
                    beforeFinal.sessions
                );
                const changed = await prisma.user.findUniqueOrThrow({
                    where: { id: target.id },
                });
                assert.equal(changed.email, destination);
                assert.equal(changed.emailVerified, true);
                const session = success(
                    await target.browser.request('get-session')
                );
                assert.equal(
                    z.object({ email: z.string() }).parse(session.user).email,
                    destination
                );
                const after = await snapshot();
                denied(
                    await redeem(target.browser, proof.token),
                    409,
                    'EMAIL_VERIFICATION_STALE'
                );
                assert.deepEqual(await snapshot(), after);
            }
        );

        await t.test(
            'tampered, synthetically expired and legacy unbound native-format tokens cannot mutate accounts',
            async () => {
                const target = await account('invalid');
                const proof = await requestVerification(target);
                const segments = proof.token.split('.');
                assert.equal(segments.length, 3);
                const signature = segments[2]!;
                const tampered = `${segments[0]}.${segments[1]}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
                // Explicit synthetic expiry, retaining all claims from a real delivered token.
                const expired = await createEmailVerificationToken(
                    secret,
                    proof.claims.email,
                    undefined,
                    -60,
                    proof.claims
                );
                const legacy = await createEmailVerificationToken(
                    secret,
                    target.email
                );
                const unknownVersion = await createEmailVerificationToken(
                    secret,
                    target.email,
                    undefined,
                    3600,
                    {
                        ...proof.claims,
                        vectorixEmailOwnership: 2,
                    }
                );
                const before = await snapshot();
                for (const token of [tampered, expired, legacy, unknownVersion])
                    denied(
                        await redeem(target.browser, token),
                        400,
                        'EMAIL_VERIFICATION_INVALID_TOKEN'
                    );
                assert.deepEqual(await snapshot(), before);
            }
        );

        await t.test(
            'an address claimed after a mailed change request causes a conflict without changing either identity',
            async () => {
                const target = await account('collision');
                const currentProof = await requestVerification(target);
                success(await redeem(target.browser, currentProof.token));
                const destination = `ownership-${run}-${++sequence}-collision@example.test`;
                const before = smtp.messages.length;
                success(
                    await target.browser.request('change-email', {
                        newEmail: destination,
                    })
                );
                const confirmation = await mailedToken(before, target.email);
                assert.equal(
                    confirmation.claims.requestType,
                    'change-email-confirmation'
                );
                assert.equal(
                    success(await redeem(target.browser, confirmation.token))
                        .outcome,
                    'NEW_ADDRESS_VERIFICATION_REQUIRED'
                );
                const proof = await mailedToken(before + 1, destination);
                assert.equal(
                    proof.claims.requestType,
                    'change-email-verification'
                );
                const claimant = browser();
                const created = success(
                    await claimant.request('sign-up/email', {
                        name: 'Late address claimant',
                        email: destination,
                        password,
                    })
                );
                const claimantId = identity.parse(created.user).id;
                f.registerUser(claimantId);
                ownedUsers.push(claimantId);
                const unchanged = await snapshot();
                const response = await redeem(target.browser, proof.token);
                denied(response, 409, 'EMAIL_VERIFICATION_STALE');
                assert.deepEqual(await snapshot(), unchanged);
            }
        );

        await t.test(
            'a pending real 2FA challenge cannot redeem a mailbox link or create a session',
            async () => {
                const target = await account('two-factor');
                const proof = await requestVerification(target);
                const enabled = success(
                    await target.browser.request('two-factor/enable', {
                        password,
                    })
                );
                const uri = new URL(z.string().parse(enabled.totpURI));
                const otpSecret = uri.searchParams.get('secret');
                assert.ok(otpSecret);
                success(
                    await target.browser.request('two-factor/verify-totp', {
                        code: totp(otpSecret),
                    })
                );
                assert.equal(
                    (
                        await prisma.user.findUniqueOrThrow({
                            where: { id: target.id },
                        })
                    ).twoFactorEnabled,
                    true
                );
                const pending = browser();
                const signedIn = success(
                    await pending.request('sign-in/email', {
                        email: target.email,
                        password,
                    })
                );
                assert.equal(signedIn.twoFactorRedirect, true);
                assert.equal((await pending.request('get-session')).body, null);
                const before = await snapshot();
                denied(
                    await redeem(pending, proof.token),
                    401,
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
                assert.deepEqual(await snapshot(), before);
                success(
                    await pending.request('two-factor/verify-totp', {
                        code: totp(otpSecret),
                    })
                );
                const authenticated = await snapshot();
                assert.equal(
                    success(await redeem(pending, proof.token)).outcome,
                    'ADDRESS_VERIFIED'
                );
                assert.deepEqual(
                    (await snapshot()).sessions,
                    authenticated.sessions
                );
            }
        );

        await t.test(
            'unverified exact invitation recipients cannot get, accept or reject; verification resumes only the intended organization',
            async () => {
                const owner = await account('inviter');
                const foreign = await account('foreign-inviter');
                const recipient = await account('invitee');
                const organizationId = await organization(owner, 'invitation');
                const foreignOrganizationId = await organization(
                    foreign,
                    'foreign invitation'
                );
                const invitationId = await invite(
                    owner,
                    organizationId,
                    recipient.email,
                    'admin'
                );
                const foreignInvitationId = await invite(
                    foreign,
                    foreignOrganizationId,
                    `ownership-${run}-foreign-recipient@example.test`
                );
                const before = await snapshot();
                denied(
                    await recipient.browser.request(
                        `organization/get-invitation?id=${invitationId}`
                    ),
                    403,
                    'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION'
                );
                for (const operation of [
                    'accept-invitation',
                    'reject-invitation',
                ])
                    denied(
                        await recipient.browser.request(
                            `organization/${operation}`,
                            { invitationId }
                        ),
                        403,
                        'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION'
                    );
                assert.equal(
                    (
                        await recipient.browser.request(
                            'organization/list-user-invitations'
                        )
                    ).response.status,
                    403
                );
                assert.deepEqual(await snapshot(), before);
                const listing = await owner.browser.request(
                    `organization/list-invitations?organizationId=${organizationId}`
                );
                assert.equal(listing.response.status, 200);
                assert.ok(
                    z
                        .array(identity)
                        .parse(listing.body)
                        .some((row) => row.id === invitationId)
                );
                assert.ok(
                    !z
                        .array(identity)
                        .parse(listing.body)
                        .some((row) => row.id === foreignInvitationId)
                );
                assert.equal(
                    (
                        await owner.browser.request(
                            `organization/list-invitations?organizationId=${foreignOrganizationId}`
                        )
                    ).response.status,
                    403
                );
                const proof = await requestVerification(
                    recipient,
                    `/dashboard/accept-invitation?id=${invitationId}`
                );
                assert.equal(
                    proof.claims.returnTo,
                    `/dashboard/accept-invitation?id=${invitationId}`
                );
                success(await redeem(recipient.browser, proof.token));
                success(
                    await recipient.browser.request(
                        `organization/get-invitation?id=${invitationId}`
                    )
                );
                const beforeForeign = await snapshot();
                assert.equal(
                    (
                        await recipient.browser.request(
                            'organization/accept-invitation',
                            { invitationId: foreignInvitationId }
                        )
                    ).response.status,
                    403
                );
                assert.deepEqual(await snapshot(), beforeForeign);
                success(
                    await recipient.browser.request(
                        'organization/accept-invitation',
                        { invitationId }
                    )
                );
                assert.equal(
                    (
                        await prisma.member.findFirstOrThrow({
                            where: { userId: recipient.id, organizationId },
                        })
                    ).role,
                    'admin'
                );
                assert.equal(
                    await prisma.member.count({
                        where: {
                            userId: recipient.id,
                            organizationId: foreignOrganizationId,
                        },
                    }),
                    0
                );
                assert.equal(
                    (
                        await prisma.invitation.findUniqueOrThrow({
                            where: { id: foreignInvitationId },
                        })
                    ).status,
                    'pending'
                );
            }
        );

        await t.test(
            'a member-known privileged invitation ID cannot turn an unproved unused address into its recipient',
            async () => {
                const owner = await account('known-id-owner');
                const attacker = await account('known-id-member');
                const organizationId = await organization(owner, 'known ID');
                // An explicit legacy unverified membership; no new invitation bypass is used to manufacture it.
                await prisma.member.create({
                    data: {
                        id: randomUUID(),
                        organizationId,
                        userId: attacker.id,
                        role: 'member',
                        createdAt: new Date(),
                    },
                });
                const invitedAddress = `ownership-${run}-${++sequence}-unused-invited@example.test`;
                const invitationId = await invite(
                    owner,
                    organizationId,
                    invitedAddress,
                    'admin'
                );
                const listed = await attacker.browser.request(
                    `organization/list-invitations?organizationId=${organizationId}`
                );
                assert.equal(listed.response.status, 200);
                assert.ok(
                    z
                        .array(identity)
                        .parse(listed.body)
                        .some((row) => row.id === invitationId)
                );
                success(
                    await attacker.browser.request('organization/leave', {
                        organizationId,
                    })
                );
                assert.equal(
                    await prisma.member.count({
                        where: { userId: attacker.id, organizationId },
                    }),
                    0
                );
                const before = await snapshot();
                denied(
                    await attacker.browser.request('change-email', {
                        newEmail: invitedAddress,
                    }),
                    403,
                    'EMAIL_VERIFICATION_CURRENT_ADDRESS_REQUIRED'
                );
                assert.deepEqual(await snapshot(), before);
                assert.equal(
                    (
                        await attacker.browser.request(
                            'organization/accept-invitation',
                            { invitationId }
                        )
                    ).response.status,
                    403
                );
                assert.deepEqual(await snapshot(), before);
                const unverified = await prisma.user.findUniqueOrThrow({
                    where: { id: attacker.id },
                });
                assert.equal(unverified.email, attacker.email);
                assert.equal(unverified.emailVerified, false);

                // Even after proving its own old mailbox, the account must
                // still prove the invited new mailbox; knowing the ID cannot
                // substitute for either proof. The new-address link is never redeemed.
                const currentProof = await requestVerification(attacker);
                success(await redeem(attacker.browser, currentProof.token));
                const mailBefore = smtp.messages.length;
                success(
                    await attacker.browser.request('change-email', {
                        newEmail: invitedAddress,
                    })
                );
                const confirmation = await mailedToken(
                    mailBefore,
                    attacker.email
                );
                assert.equal(
                    confirmation.claims.requestType,
                    'change-email-confirmation'
                );
                assert.equal(
                    success(await redeem(attacker.browser, confirmation.token))
                        .outcome,
                    'NEW_ADDRESS_VERIFICATION_REQUIRED'
                );
                const pendingNewProof = await mailedToken(
                    mailBefore + 1,
                    invitedAddress
                );
                assert.equal(
                    pendingNewProof.claims.requestType,
                    'change-email-verification'
                );
                const unchanged = await snapshot();
                assert.equal(
                    (
                        await attacker.browser.request(
                            'organization/accept-invitation',
                            { invitationId }
                        )
                    ).response.status,
                    403
                );
                assert.deepEqual(await snapshot(), unchanged);
                const user = await prisma.user.findUniqueOrThrow({
                    where: { id: attacker.id },
                });
                assert.equal(user.email, attacker.email);
                assert.equal(user.emailVerified, true);
                assert.equal(
                    (
                        await prisma.invitation.findUniqueOrThrow({
                            where: { id: invitationId },
                        })
                    ).status,
                    'pending'
                );
                assert.equal(
                    await prisma.member.count({
                        where: { userId: attacker.id, organizationId },
                    }),
                    0
                );
            }
        );

        await t.test(
            'an actual concurrent old-address reassignment cannot retarget the conditional verification write',
            async () => {
                const target = await account('race-target');
                const replacement = await account('race-replacement');
                const proof = await requestVerification(target);
                const movedAddress = `ownership-${run}-${++sequence}-moved@example.test`;
                const blocker = await database.connect();
                let pending: ReturnType<typeof redeem> | undefined;
                let committed = false;
                try {
                    await blocker.query('BEGIN');
                    const pid = z
                        .object({ pid: z.number().int() })
                        .parse(
                            (
                                await blocker.query(
                                    'SELECT pg_backend_pid() AS pid'
                                )
                            ).rows[0]
                        ).pid;
                    await blocker.query(
                        'UPDATE "user" SET email=$1 WHERE id=$2',
                        [movedAddress, target.id]
                    );
                    await blocker.query(
                        'UPDATE "user" SET email=$1 WHERE id=$2',
                        [target.email, replacement.id]
                    );
                    pending = redeem(target.browser, proof.token);
                    const until = Date.now() + 4000;
                    let waiting = false;
                    while (Date.now() < until) {
                        // Prisma cannot express a database lock barrier. No query text or unrelated row data is projected.
                        const observed = await database.query<{
                            waiting: boolean;
                        }>(
                            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                         WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) AS waiting`,
                            [pid]
                        );
                        if (observed.rows[0]?.waiting) {
                            waiting = true;
                            break;
                        }
                        await delay(10);
                    }
                    assert.ok(
                        waiting,
                        'The real HTTP conditional mutation must wait on the owned user row.'
                    );
                    await blocker.query('COMMIT');
                    committed = true;
                    denied(await pending, 409, 'EMAIL_VERIFICATION_STALE');
                    const targetAfter = await prisma.user.findUniqueOrThrow({
                        where: { id: target.id },
                    });
                    const replacementAfter =
                        await prisma.user.findUniqueOrThrow({
                            where: { id: replacement.id },
                        });
                    assert.equal(targetAfter.email, movedAddress);
                    assert.equal(targetAfter.emailVerified, false);
                    assert.equal(replacementAfter.email, target.email);
                    assert.equal(replacementAfter.emailVerified, false);
                } finally {
                    if (!committed) await blocker.query('ROLLBACK');
                    blocker.release();
                    if (pending) await Promise.allSettled([pending]);
                }
            }
        );
        smtp.assertHealthy();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await database.end();
        await smtp.close();
    }
}
