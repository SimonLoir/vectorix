#!/usr/bin/env node
/** Prove both local artifacts work outside the workspace without publishing anything. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'vectorix-client-packages-'));
const artifacts = join(directory, 'artifacts');
const consumer = join(directory, 'consumer');
const environment = {
    PATH: process.env.PATH,
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    CI: 'true',
};

/** Every child has an explicit deadline, isolated environment and bounded diagnostics. */
function run(command, args, cwd = root) {
    const result = spawnSync(command, args, {
        cwd,
        env: environment,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
        shell: false,
    });
    if (result.status !== 0) {
        // This helper uses only fixed synthetic values, never an application key.
        process.stderr.write((result.stderr ?? '').slice(-8000));
        process.stderr.write((result.stdout ?? '').slice(-8000));
        throw new Error('External client package check failed.');
    }
    return result.stdout;
}

let mcpClient;
let transport;
try {
    mkdirSync(artifacts, { mode: 0o700 });
    mkdirSync(consumer, { mode: 0o700 });
    run('pnpm', [
        'exec',
        'turbo',
        'run',
        'build',
        '--filter=@vectorix/client',
        '--filter=@vectorix/mcp',
    ]);
    const tarballs = [];
    for (const name of ['client', 'mcp']) {
        const manifest = JSON.parse(
            readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')
        );
        run('pnpm', [
            '--filter',
            `@vectorix/${name}`,
            'pack',
            '--pack-destination',
            artifacts,
        ]);
        const tarball = join(
            artifacts,
            `vectorix-${name}-${manifest.version}.tgz`
        );
        const entries = run('tar', ['-tzf', tarball]).trim().split('\n');
        assert.ok(
            entries.every((entry) =>
                /^package\/(?:package\.json|README\.md|LICENSE|dist\/[^\s]+)$/u.test(
                    entry
                )
            )
        );
        assert.ok(
            entries.some((entry) =>
                entry.endsWith(name === 'client' ? '/index.js' : '/cli.mjs')
            )
        );
        tarballs.push(tarball);
    }
    writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({
            name: 'vectorix-external-consumer-test',
            packageManager: JSON.parse(
                readFileSync(join(root, 'package.json'), 'utf8')
            ).packageManager,
            private: true,
            type: 'module',
            dependencies: {
                '@vectorix/client': `file:${tarballs[0]}`,
                '@vectorix/mcp': `file:${tarballs[1]}`,
            },
        }),
        { mode: 0o600 }
    );
    // Explicitly reuse the workspace store across filesystem mounts; pnpm may
    // otherwise choose a new store under the temporary mount point.
    const store = run('pnpm', ['store', 'path']).trim();
    assert.ok(store.endsWith('/v11'));
    run(
        'pnpm',
        [
            'install',
            '--ignore-scripts',
            '--lockfile=false',
            '--store-dir',
            dirname(store),
        ],
        consumer
    );
    writeFileSync(
        join(consumer, 'consumer.ts'),
        `
import { createVectorixClient, type RetrievalSearchInput, type VectorixApiV1Outputs } from '@vectorix/client';
const client = createVectorixClient({ apiUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-package-key', organizationId: 'synthetic-org' });
const input: RetrievalSearchInput = { collectionId: 'synthetic-collection', query: 'honey', strategy: 'LEXICAL', topK: 1, filters: {} };
export const search = () => client.retrieval.search(input);
export type Results = VectorixApiV1Outputs['retrieval']['search'];
`,
        { mode: 0o600 }
    );
    const sdkDeclaration = readFileSync(
        join(consumer, 'node_modules/@vectorix/client/dist/index.d.ts'),
        'utf8'
    );
    assert.doesNotMatch(
        sdkDeclaration,
        /(?:@repo\/|@routers\/|workspace:|prisma|\/home\/)/u
    );
    const packedManifest = JSON.parse(
        readFileSync(
            join(consumer, 'node_modules/@vectorix/mcp/package.json'),
            'utf8'
        )
    );
    assert.equal(packedManifest.dependencies['@vectorix/client'], undefined);
    assert.equal(packedManifest.dependencies['@orpc/client'], '^1.16.0');
    run(
        process.execPath,
        [
            join(root, 'node_modules/typescript/bin/tsc6'),
            '--strict',
            '--noEmit',
            '--module',
            'NodeNext',
            '--moduleResolution',
            'NodeNext',
            '--target',
            'ES2022',
            '--skipLibCheck',
            'false',
            'consumer.ts',
        ],
        consumer
    );
    writeFileSync(
        join(consumer, 'runtime.mjs'),
        `
import assert from 'node:assert/strict';
import { createVectorixClient } from '@vectorix/client';
let calls = 0;
const client = createVectorixClient({ apiUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-package-key', organizationId: 'synthetic-org', fetch: async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get('x-api-key'), 'synthetic-package-key');
    assert.equal(request.headers.get('Vectorix-Expected-Organization-Id'), 'synthetic-org');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    assert.equal(request.url, 'http://127.0.0.1:1/rpc/v1/admin/rag/collections/list');
    calls += 1;
    return Response.json({ json: { items: [], total: 0 } }, { headers: { 'Vectorix-API-Version': '1', 'Vectorix-API-Revision': '24' } });
}});
assert.deepEqual(await client.admin.rag.collections.list({ query: '', offset: 0, limit: 1 }), { items: [], total: 0 });
assert.equal(calls, 1);
`,
        { mode: 0o600 }
    );
    run(process.execPath, [join(consumer, 'runtime.mjs')], consumer);

    const mcpOnlyConsumer = join(directory, 'mcp-only');
    mkdirSync(mcpOnlyConsumer, { mode: 0o700 });
    writeFileSync(
        join(mcpOnlyConsumer, 'package.json'),
        JSON.stringify({
            name: 'vectorix-mcp-only-consumer-test',
            private: true,
            type: 'module',
            packageManager: JSON.parse(
                readFileSync(join(root, 'package.json'), 'utf8')
            ).packageManager,
            dependencies: { '@vectorix/mcp': `file:${tarballs[1]}` },
        }),
        { mode: 0o600 }
    );
    run(
        'pnpm',
        [
            'install',
            '--ignore-scripts',
            '--lockfile=false',
            '--store-dir',
            dirname(store),
        ],
        mcpOnlyConsumer
    );

    const mcpRequire = createRequire(join(root, 'packages/mcp/package.json'));
    const { Client } = await import(
        pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/client')).href
    );
    const { StdioClientTransport } = await import(
        pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/client/stdio'))
            .href
    );
    transport = new StdioClientTransport({
        command: process.execPath,
        args: [
            join(mcpOnlyConsumer, 'node_modules/@vectorix/mcp/dist/cli.mjs'),
        ],
        cwd: mcpOnlyConsumer,
        env: {
            PATH: process.env.PATH ?? '',
            VECTORIX_API_URL: 'http://127.0.0.1:1',
            VECTORIX_API_KEY: 'synthetic-package-key',
            VECTORIX_ORGANIZATION_ID: 'synthetic-org',
            VECTORIX_COLLECTION_IDS: 'synthetic-collection',
        },
        stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4096);
    });
    mcpClient = new Client(
        {
            name: 'vectorix-package-smoke',
            version: '1.0.0',
        },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    const deadline = AbortSignal.timeout(15_000);
    await mcpClient.connect(transport, { signal: deadline });
    const tools = await mcpClient.listTools({}, { signal: deadline });
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'get_source',
        'list_collections',
        'search_collection',
    ]);
    assert.equal(stderr, '');
    console.log(
        'Packed SDK types/runtime and packaged MCP stdio discovery passed in fresh external consumers.'
    );
} finally {
    await mcpClient?.close();
    await transport?.close();
    assert.ok(
        directory.startsWith(join(tmpdir(), 'vectorix-client-packages-'))
    );
    rmSync(directory, { recursive: true, force: true });
}
