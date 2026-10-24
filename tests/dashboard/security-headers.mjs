import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

// This source is passed on stdin to Node inside each freshly deployed image.
// Keep expectations independent of the configuration that produces the headers.
const expectedHeaders = {
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
};
const workerCsp =
    "default-src 'none'; script-src 'self'; frame-ancestors 'none'";
const app = process.env.TEST_APP;
const port = process.env.TEST_PORT;
assert.ok(
    (app === 'web' && port === '3000') || (app === 'admin' && port === '3006'),
    'Only the two isolated frontend smoke targets are allowed'
);
const base = `http://127.0.0.1:${port}`;
const apiPort = process.env.TEST_API_PORT ?? '3001';
assert.ok(
    apiPort === '3001' || apiPort === '3101',
    'Only the isolated smoke API ports are allowed'
);
const api = `http://api:${apiPort}`;
const trustedOrigin = `http://localhost:${port}`;
const protectedPath = app === 'web' ? '/dashboard' : '/';
const identifier = randomUUID();
let stage = 'sign-in document';
let totalBytes = 0;

/** Read bounded response bytes without exposing authentication responses. */
async function request(url, options = {}, limit = 8 * 1024 * 1024) {
    const response = await fetch(url, {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
    });
    const chunks = [];
    let length = 0;
    if (response.body) {
        const reader = response.body.getReader();
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.byteLength;
                totalBytes += chunk.value.byteLength;
                assert.ok(length <= limit, 'Response exceeds its byte limit');
                assert.ok(
                    totalBytes <= 32 * 1024 * 1024,
                    'Frontend smoke responses exceed the total byte limit'
                );
                chunks.push(chunk.value);
            }
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
    }
    return { response, bytes: Buffer.concat(chunks, length) };
}

/** Assert each literal independently, including non-document responses. */
function assertPolicy(
    response,
    csp = expectedHeaders['content-security-policy']
) {
    for (const [name, value] of Object.entries(expectedHeaders)) {
        assert.equal(
            response.headers.get(name),
            name === 'content-security-policy' ? csp : value,
            `Expected ${name}`
        );
    }
}

function assertHtml(result) {
    assert.equal(result.response.status, 200, 'Expected an HTML document');
    assert.match(
        result.response.headers.get('content-type') ?? '',
        /^text\/html(?:;|$)/i,
        'Document must have an HTML content type'
    );
    assertPolicy(result.response);
    const html = result.bytes.toString('utf8');
    assert.ok(
        html.includes(api),
        'API_URL must be supplied to the frontend at runtime'
    );
    return html;
}

/** No response body or credential value is used in assertion diagnostics. */
function privateJson(bytes) {
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('Authentication returned an invalid JSON envelope');
    }
}

async function assertStaticAssets(html) {
    const urls = new Set();
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const url = new URL(match[1].replaceAll('&amp;', '&'), base);
        if (!url.pathname.startsWith('/_next/static/')) continue;
        assert.equal(url.origin, base, 'Frontend assets must be local');
        if (/\.(?:js|css)$/.test(url.pathname)) urls.add(url.href);
    }
    assert.ok(
        urls.size > 0 && urls.size <= 64,
        'Expected a bounded asset list'
    );
    assert.ok([...urls].some((url) => new URL(url).pathname.endsWith('.js')));
    assert.ok([...urls].some((url) => new URL(url).pathname.endsWith('.css')));
    for (const url of urls) {
        const result = await request(url);
        assert.equal(
            result.response.status,
            200,
            'Loaded static asset must exist'
        );
        assertPolicy(result.response);
        const pattern = new URL(url).pathname.endsWith('.css')
            ? /^text\/css(?:;|$)/i
            : /^(?:application|text)\/javascript(?:;|$)/i;
        assert.match(
            result.response.headers.get('content-type') ?? '',
            pattern,
            'Static assets must have the correct MIME type'
        );
        assert.ok(result.bytes.length > 0, 'Static asset must not be empty');
    }
    return urls.size;
}

async function assertWebPublicFiles() {
    stage = 'service worker';
    const worker = await request(`${base}/sw.js`, {}, 256 * 1024);
    assert.equal(worker.response.status, 200);
    assertPolicy(worker.response, workerCsp);
    assert.equal(
        worker.response.headers.get('content-type'),
        'application/javascript; charset=utf-8'
    );
    assert.equal(
        worker.response.headers.get('cache-control'),
        'no-cache, no-store, must-revalidate'
    );
    assert.equal(worker.response.headers.get('service-worker-allowed'), '/');
    assert.ok(worker.bytes.length > 0);

    stage = 'manifest and icon';
    const manifest = await request(
        `${base}/manifest.webmanifest`,
        {},
        64 * 1024
    );
    assert.equal(manifest.response.status, 200);
    assertPolicy(manifest.response);
    assert.match(
        manifest.response.headers.get('content-type') ?? '',
        /^application\/manifest\+json(?:;|$)/i
    );
    const data = privateJson(manifest.bytes);
    assert.equal(data.start_url, '/dashboard');
    assert.ok(Array.isArray(data.icons) && data.icons.length === 1);
    assert.equal(data.icons[0].src, '/icons/app.svg');
    assert.equal(data.icons[0].type, 'image/svg+xml');
    const icon = await request(`${base}/icons/app.svg`, {}, 256 * 1024);
    assert.equal(icon.response.status, 200);
    assertPolicy(icon.response);
    assert.match(
        icon.response.headers.get('content-type') ?? '',
        /^image\/svg\+xml(?:;|$)/i
    );
    assert.ok(icon.bytes.length > 0);
}

/**
 * A normal native account proves the proxy admits a sessionful HTML request.
 * The admin shell's HTTP200 does not establish superadmin authorization. The
 * disposable database owns these accounts; no role changes or direct database
 * writes occur.
 */
async function assertSessionfulDocument() {
    stage = 'native session fixture';
    const cookies = new Map();
    try {
        const signup = await request(
            `${api}/api/auth/sign-up/email`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: trustedOrigin,
                },
                body: JSON.stringify({
                    name: 'Header transport check',
                    email: `headers-${app}-${identifier}@example.test`,
                    password: `Header-check-${randomBytes(24).toString('hex')}!`,
                }),
            },
            64 * 1024
        );
        assert.equal(
            signup.response.status,
            200,
            'Native sign-up must succeed'
        );
        const user = privateJson(signup.bytes).user;
        assert.ok(
            typeof user?.id === 'string',
            'Native sign-up must return a user'
        );
        const setCookies = signup.response.headers.getSetCookie();
        assert.ok(setCookies.length > 0 && setCookies.length <= 16);
        for (const value of setCookies) {
            assert.ok(value.length <= 16_384, 'Cookie exceeds its byte limit');
            const pair = value.split(';', 1)[0];
            const separator = pair.indexOf('=');
            assert.ok(separator > 0, 'Native cookie must have a name');
            cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        const cookie = [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join('; ');
        assert.ok(cookie.length > 0 && cookie.length <= 32_768);
        const session = await request(
            `${api}/api/auth/get-session`,
            { headers: { cookie } },
            64 * 1024
        );
        assert.equal(
            session.response.status,
            200,
            'Native session must be readable'
        );
        const sessionData = privateJson(session.bytes);
        assert.ok(
            sessionData?.user?.id === user.id &&
                typeof sessionData?.session?.id === 'string',
            'Native session must belong to the synthetic account'
        );

        stage = 'authenticated dashboard document';
        assertHtml(
            await request(`${base}${protectedPath}`, { headers: { cookie } })
        );
    } finally {
        cookies.clear();
    }
}

async function main() {
    const html = assertHtml(await request(`${base}/sign-in`));

    stage = 'unauthenticated proxy redirect';
    const redirect = await request(`${base}${protectedPath}`);
    assert.equal(
        redirect.response.status,
        307,
        'Auth proxy must actually redirect'
    );
    assertPolicy(redirect.response);
    const destination = new URL(
        redirect.response.headers.get('location') ?? '',
        base
    );
    assert.equal(destination.origin, base);
    assert.equal(destination.pathname, '/sign-in');
    assert.equal(destination.search, '');
    assert.equal(destination.hash, '');

    stage = 'final sign-in document';
    assertHtml(await request(destination));

    stage = 'missing static asset';
    const missing = await request(
        `${base}/_next/static/missing-${identifier}.js`
    );
    assert.equal(
        missing.response.status,
        404,
        'Probe must be a real missing asset'
    );
    assertPolicy(missing.response);

    stage = 'loaded JavaScript and CSS';
    const assetCount = await assertStaticAssets(html);
    if (app === 'web') await assertWebPublicFiles();
    await assertSessionfulDocument();
    console.log(
        `${app}: independent headers passed on documents, auth307, static404 and ${assetCount} JS/CSS assets; native-session document200 verified (transport only)`
    );
}

main().catch((error) => {
    // Never serialize an authentication response, cookie jar, request or cause.
    const detail =
        error instanceof assert.AssertionError
            ? error.message
            : 'bounded HTTP check failed';
    console.error(
        `${app}: security-header regression failed at ${stage}: ${detail}`
    );
    process.exitCode = 1;
});
