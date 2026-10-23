import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { app } from './app';
import { createScalarAssetHandler } from './api-versioning/scalar-asset';
import {
    createScalarBundleLoader,
    MAX_SCALAR_BUNDLE_BYTES,
    readInstalledScalarBundle,
    readScalarBundleFile,
    SCALAR_VERSION,
    ScalarBundleUnavailableError,
} from './api-versioning/scalar-bundle';
import { SCALAR_ICON_PATH } from './api-versioning/scalar-icon';
import { createScalarPageHandler } from './api-versioning/scalar-page';
import {
    getPublicApiVersions,
    type PublicApiVersion,
} from './api-versioning/registry';
import { createScalarConfig, renderScalarHtml } from './api-versioning/scalar';

const versions = getPublicApiVersions();

function cspDirectives(policy: string) {
    return new Map<string, string[]>(
        policy
            .split(';')
            .map((entry) => entry.trim().split(/\s+/))
            .filter(([name]) => Boolean(name))
            .map(([name, ...values]): [string, string[]] => [name!, values])
    );
}

function localScript(html: string) {
    const path = /<script\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
    assert.ok(path, 'the page must reference its packaged script');
    assert.match(path, /^\/_playground\/scalar\/[a-f0-9]{64}\.js$/);
    return path;
}

void test('the real app serves the exact pinned Scalar bytes with an immutable digest identity', async () => {
    assert.equal(SCALAR_VERSION, '1.75.1');
    const expected = readInstalledScalarBundle();
    assert.ok(expected.byteLength > 0);
    assert.ok(expected.byteLength <= MAX_SCALAR_BUNDLE_BYTES);
    const sha256 = createHash('sha256').update(expected).digest('hex');
    const html = await (await app.request('/')).text();
    const path = localScript(html);
    assert.equal(path, `/_playground/scalar/${sha256}.js`);
    assert.ok(
        html.includes(
            `integrity="sha384-${createHash('sha384').update(expected).digest('base64')}"`
        )
    );
    const result = await app.request(path);
    assert.equal(result.status, 200);
    assert.match(
        result.headers.get('content-type') ?? '',
        /^(?:application|text)\/javascript(?:;\s*charset=utf-8)?$/i
    );
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
        result.headers.get('cache-control'),
        'public, max-age=31536000, immutable'
    );
    const etag = result.headers.get('etag');
    assert.ok(etag && etag.includes(sha256));
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), expected);
    const cached = await app.request(path, {
        headers: { 'if-none-match': etag },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get('etag'), etag);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    for (const validator of [`W/${etag}`, `"other", ${etag}`, '*']) {
        const unchanged = await app.request(path, {
            headers: { 'if-none-match': validator },
        });
        assert.equal(unchanged.status, 304);
        assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    }
    const head = await app.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('etag'), etag);
    assert.equal(
        head.headers.get('content-type'),
        result.headers.get('content-type')
    );
    assert.equal((await head.arrayBuffer()).byteLength, 0);
});

void test('unknown asset identities and traversal-shaped paths cannot read another file', async () => {
    const html = await (await app.request('/')).text();
    const path = localScript(html);
    const prefix = '/_playground/scalar/';
    const basename = path.slice(prefix.length);
    const firstCharacter = basename.codePointAt(0);
    assert.ok(firstCharacter !== undefined);
    const encodedFirstCharacter = `%${firstCharacter.toString(16)}`;
    for (const refused of [
        `${prefix}${'0'.repeat(64)}.js`,
        `${prefix}${basename}.map`,
        `${prefix}package.json`,
        `${prefix}../package.json`,
        `${prefix}%2e%2e%2fpackage.json`,
        `${prefix}${encodedFirstCharacter}${basename.slice(1)}`,
        `${path}/extra`,
        '/_playground/other.js',
    ]) {
        const response = await app.request(refused);
        assert.equal(response.status, 404, refused);
        assert.doesNotMatch(
            await response.text(),
            /node_modules|PRIVATE_|BEGIN PRIVATE KEY/
        );
    }
});

void test('each page has fresh matching nonces, no cache and a narrowly scoped inline-style exception', async () => {
    const seen = new Set<string>();
    for (let request = 0; request < 2; request++) {
        const response = await app.request('/');
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const html = await response.text();
        const policy = response.headers.get('content-security-policy');
        assert.ok(policy);
        const directives = cspDirectives(policy);
        assert.deepEqual(directives.get('default-src'), ["'none'"]);
        assert.deepEqual(directives.get('connect-src'), ["'self'"]);
        assert.deepEqual(directives.get('object-src'), ["'none'"]);
        assert.deepEqual(directives.get('base-uri'), ["'none'"]);
        const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
        assert.equal(scripts.length, 2);
        const nonces = scripts.map(
            ([, attributes]) => /\bnonce="([^"]+)"/.exec(attributes!)?.[1]
        );
        assert.ok(nonces[0]);
        assert.match(nonces[0], /^[A-Za-z0-9+/]{32}$/);
        assert.ok(nonces.every((nonce) => nonce === nonces[0]));
        const stylesheetNonce =
            /<meta\b[^>]*\bproperty="csp-nonce"[^>]*\bcontent="([^"]+)"/.exec(
                html
            )?.[1];
        assert.equal(stylesheetNonce, nonces[0]);
        assert.ok(
            directives.get('script-src')?.includes(`'nonce-${nonces[0]}'`)
        );
        assert.ok(!directives.get('script-src')?.includes("'unsafe-inline'"));
        assert.ok(directives.get('style-src')?.includes("'unsafe-inline'"));
        assert.doesNotMatch(policy, /unsafe-eval|https?:|\*/);
        assert.ok(!seen.has(nonces[0]));
        seen.add(nonces[0]);
        assert.doesNotMatch(html, /https?:\/\/|cdn\.jsdelivr|unpkg|orpc\.dev/);
        assert.ok(html.includes(`href="${SCALAR_ICON_PATH}"`));
    }
});

void test('registry configuration disables external integrations and persistent authentication explicitly', () => {
    const config = createScalarConfig(versions);
    assert.deepEqual(
        config.sources,
        versions.map((version) => ({
            title: `Vectorix API v${version.major} (revision ${version.revision})`,
            slug: `v${version.major}`,
            url: version.specPath,
            default: version.status === 'current',
        }))
    );
    assert.equal(config.showDeveloperTools, 'never');
    assert.equal(config.withDefaultFonts, false);
    assert.equal(config.telemetry, false);
    assert.equal(config.persistAuth, false);
    assert.deepEqual(config.agent, { disabled: true });
    assert.deepEqual(config.mcp, { disabled: true });
    assert.ok(!Object.hasOwn(config, 'proxyUrl'));
    assert.deepEqual(config.authentication.securitySchemes.ApiKeyAuth, {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
    });
});

void test('multi-major HTML escapes hostile runtime configuration without losing registry sources', () => {
    const historical: PublicApiVersion = {
        major: 2,
        revision: 7,
        status: 'deprecated',
        rpcPath: '/rpc/v2',
        restPath: '/api/v2',
        specPath: '/spec/v2.json',
    };
    // Exercise runtime input independently of the compile-time path template.
    const hostile = '</script><script>PRIVATE_CONFIG</script>\u2028\u2029';
    Object.defineProperty(historical, 'specPath', { value: hostile });
    const html = renderScalarHtml([...versions, historical], {
        nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        bundlePath: `/_playground/scalar/${'a'.repeat(64)}.js`,
        integrity: `sha256-${Buffer.alloc(32).toString('base64')}`,
    });
    assert.equal([...html.matchAll(/<script\b/g)].length, 2);
    assert.doesNotMatch(html, /<script>PRIVATE_CONFIG/);
    assert.ok(html.includes(String.raw`\u003c/script>`));
    assert.ok(html.includes(String.raw`\u2028\u2029`));
    assert.ok(!html.includes('\u2028') && !html.includes('\u2029'));
    for (const version of versions) assert.ok(html.includes(version.specPath));
    assert.ok(html.includes('Vectorix API v2 (revision 7)'));
    assert.ok(html.includes('"default":false'));
});

void test('the favicon is a local inert SVG with its own safe content type', async () => {
    assert.equal(SCALAR_ICON_PATH, '/_playground/icon.svg');
    const result = await app.request(SCALAR_ICON_PATH);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    const icon = await result.text();
    assert.match(icon, /<svg\b/);
    assert.doesNotMatch(
        icon,
        /<script|\bon\w+\s*=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i
    );
});

void test('packaged loading is cached, bounded and never falls back to the source dependency', () => {
    let packagedReads = 0,
        sourceReads = 0;
    const bytes = Buffer.from('window.Scalar = {};');
    const loader = createScalarBundleLoader({
        packaged: true,
        readFile() {
            packagedReads++;
            return bytes;
        },
        installedSource() {
            sourceReads++;
            assert.fail(
                'a packaged runtime cannot resolve the development package'
            );
        },
    });
    assert.deepEqual(Buffer.from(loader().bytes), bytes);
    assert.deepEqual(Buffer.from(loader().bytes), bytes);
    assert.equal(packagedReads, 1);
    for (const readFile of [
        () => {
            throw new Error('PRIVATE_PATH PRIVATE_CONFIGURATION');
        },
        () => new Uint8Array(0),
        () => new Uint8Array(MAX_SCALAR_BUNDLE_BYTES + 1),
    ]) {
        const invalid = createScalarBundleLoader({
            packaged: true,
            readFile,
            installedSource() {
                sourceReads++;
                return bytes;
            },
        });
        assert.throws(invalid, (error) => {
            assert.ok(error instanceof ScalarBundleUnavailableError);
            assert.doesNotMatch(error.message, /PRIVATE_|node_modules/);
            return true;
        });
    }
    assert.equal(sourceReads, 0);
});

void test('the file reader checks actual size and missing packaged assets produce finite no-store 503s', async () => {
    const directory = mkdtempSync(
        nodePath.join(tmpdir(), 'vectorix-scalar-test-')
    );
    try {
        const path = nodePath.join(directory, 'scalar.js');
        const bytes = Buffer.from('window.Scalar = {};');
        writeFileSync(path, bytes);
        assert.deepEqual(readScalarBundleFile(pathToFileURL(path)), bytes);
        truncateSync(path, MAX_SCALAR_BUNDLE_BYTES + 1);
        assert.throws(
            () => readScalarBundleFile(pathToFileURL(path)),
            ScalarBundleUnavailableError
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
    const load = createScalarBundleLoader({
        packaged: true,
        readFile() {
            throw new Error('PRIVATE_MISSING_PATH');
        },
        installedSource() {
            assert.fail('a missing package asset must never fall back');
        },
    });
    const unavailable = new Hono();
    unavailable.get('/', createScalarPageHandler(versions, load));
    unavailable.get('/_playground/scalar/*', createScalarAssetHandler(load));
    for (const path of ['/', `/_playground/scalar/${'a'.repeat(64)}.js`]) {
        const result = await unavailable.request(path);
        assert.equal(result.status, 503);
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(
            await result.text(),
            /PRIVATE_|node_modules|ENOENT|stack|cdn\.jsdelivr/
        );
    }
});
