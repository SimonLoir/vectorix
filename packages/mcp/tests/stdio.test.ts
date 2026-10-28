import assert from 'node:assert/strict';
import test from 'node:test';
import { isCallToolResult } from '@modelcontextprotocol/client';
import {
    citation,
    collection,
    connectFixture,
    context,
    fixtureExpiry,
    fixtureReceipt,
    jsonOutput,
    search,
    structured,
} from './fixture';

await test(
    'official stdio client discovers only bounded read-only tools without API I/O',
    { timeout: 20_000 },
    async (t) => {
        const { client, calls } = await connectFixture(t, () => {
            throw new Error('No HTTP expected');
        });
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).toSorted(), [
            'get_source',
            'list_collections',
            'search_collection',
        ]);
        for (const tool of tools.tools) {
            assert.equal(tool.annotations?.readOnlyHint, true);
            assert.equal(tool.annotations?.destructiveHint, false);
        }
        assert.equal(
            tools.tools.find((tool) => tool.name === 'search_collection')
                ?.annotations?.idempotentHint,
            false
        );
        assert.match(
            tools.tools.find((tool) => tool.name === 'search_collection')
                ?.description ?? '',
            /costs/u
        );
        assert.equal(calls.length, 0);
    }
);

await test(
    'collection listing filters local restrictions/read grants and omits configuration and remote totals',
    { timeout: 20_000 },
    async (t) => {
        const { client, calls } = await connectFixture(t, () => ({
            output: {
                items: [
                    collection('collection-a'),
                    collection('collection-b'),
                    collection('collection-c', false),
                ],
                total: 45,
            },
        }));
        const output = structured(
            await client.callTool({
                name: 'list_collections',
                arguments: { limit: 3 },
            })
        );
        assert.deepEqual(output, {
            items: [
                {
                    id: 'collection-a',
                    name: 'Collection collection-a',
                    description: 'An untrusted collection description.',
                },
            ],
            nextOffset: 3,
            pageIsFiltered: true,
        });
        assert.equal(calls[0]?.path, '/rpc/v1/admin/rag/collections/list');
        assert.doesNotMatch(
            JSON.stringify(output),
            /private-credential|private-vector|configuration|total/u
        );
    }
);

await test(
    'search uses the pinned SDK headers, selected collection and native filters; receipts and untrusted text survive exactly',
    { timeout: 20_000 },
    async (t) => {
        const { client, calls } = await connectFixture(t, () => ({
            output: search(),
        }));
        const result = await client.callTool({
            name: 'search_collection',
            arguments: {
                collectionId: 'collection-a',
                query: 'question',
                strategy: 'LEXICAL',
                topK: 1,
                filters: { languages: ['EN'], tags: ['manual'] },
            },
        });
        const output = structured(result);
        assert.deepEqual(output, jsonOutput(search()));
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.path, '/rpc/v1/retrieval/search');
        assert.deepEqual(calls[0]?.input, {
            collectionId: 'collection-a',
            query: 'question',
            topK: 1,
            strategy: 'LEXICAL',
            filters: { languages: ['EN'], tags: ['manual'] },
        });
        assert.ok(isCallToolResult(result));
        assert.match(JSON.stringify(result.content[0]), /untrusted/u);
        assert.doesNotMatch(
            JSON.stringify(result.content[0]),
            /Ignore all previous/u
        );
    }
);

await test(
    'local collection restriction and unknown organization/URL arguments refuse before HTTP',
    { timeout: 20_000 },
    async (t) => {
        const { client, calls } = await connectFixture(t, () => {
            throw new Error('No HTTP expected');
        });
        const denied = await client.callTool({
            name: 'search_collection',
            arguments: { collectionId: 'foreign', query: 'question' },
        });
        assert.ok(isCallToolResult(denied));
        assert.deepEqual(denied.content, [
            { type: 'text', text: 'COLLECTION_NOT_ALLOWED' },
        ]);
        assert.equal(denied.isError, true);
        const invalid = await client.callTool({
            name: 'get_source',
            arguments: {
                collectionId: 'collection-a',
                receipt: fixtureReceipt,
                organizationId: 'foreign',
                url: 'https://foreign.test',
            },
        });
        assert.ok(isCallToolResult(invalid));
        assert.equal(invalid.isError, true);
        assert.equal(calls.length, 0);
    }
);

await test(
    'exact citation and bounded context share the original receipt and expiry without original file fetch',
    { timeout: 20_000 },
    async (t) => {
        const { client, calls } = await connectFixture(t, (call) => ({
            output: call.path.endsWith('/citation') ? citation() : context(),
        }));
        const output = structured(
            await client.callTool({
                name: 'get_source',
                arguments: {
                    collectionId: 'collection-a',
                    receipt: fixtureReceipt,
                    before: 2,
                    after: 0,
                },
            })
        );
        assert.deepEqual(
            output,
            jsonOutput({ citation: citation(), context: context() })
        );
        assert.deepEqual(
            calls.map((call) => call.path),
            ['/rpc/v1/retrieval/citation', '/rpc/v1/retrieval/context']
        );
        assert.deepEqual(calls[1]?.input, {
            collectionId: 'collection-a',
            receipt: fixtureReceipt,
            before: 2,
            after: 0,
        });
        assert.ok(JSON.stringify(output).includes(fixtureExpiry.toISOString()));
    }
);

await test(
    'revocation/error responses are sanitized, not cached, and stop source expansion',
    { timeout: 20_000 },
    async (t) => {
        let revoked = false;
        const { client, calls } = await connectFixture(t, () =>
            revoked
                ? {
                      status: 403,
                      output: {
                          defined: false,
                          code: 'FORBIDDEN',
                          status: 403,
                          message: 'private-provider-secret query-content',
                          data: { password: 'never-print' },
                      },
                  }
                : { output: search() }
        );
        structured(
            await client.callTool({
                name: 'search_collection',
                arguments: { collectionId: 'collection-a', query: 'question' },
            })
        );
        revoked = true;
        const denied = await client.callTool({
            name: 'get_source',
            arguments: {
                collectionId: 'collection-a',
                receipt: fixtureReceipt,
            },
        });
        assert.ok(isCallToolResult(denied));
        assert.deepEqual(denied.content, [
            { type: 'text', text: 'ACCESS_DENIED' },
        ]);
        assert.equal(denied.isError, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[1]?.path, '/rpc/v1/retrieval/citation');
        assert.doesNotMatch(
            JSON.stringify(denied),
            /private-provider|query-content|never-print|Ignore all/u
        );
    }
);

await test(
    'mismatched exact citation/context receipts are refused instead of relabeled',
    { timeout: 20_000 },
    async (t) => {
        const { client } = await connectFixture(t, (call) => ({
            output: call.path.endsWith('/citation')
                ? citation()
                : { ...context(), version: 2 },
        }));
        const result = await client.callTool({
            name: 'get_source',
            arguments: {
                collectionId: 'collection-a',
                receipt: fixtureReceipt,
            },
        });
        assert.ok(isCallToolResult(result));
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [
            { type: 'text', text: 'INVALID_API_RESPONSE' },
        ]);
    }
);

await test(
    'revocation between citation and context returns no partial citation or cached content',
    { timeout: 20_000 },
    async (t) => {
        const { client, calls } = await connectFixture(t, (call) =>
            call.path.endsWith('/citation')
                ? { output: citation() }
                : {
                      status: 403,
                      output: {
                          defined: false,
                          code: 'FORBIDDEN',
                          status: 403,
                          message: 'private-denial',
                          data: { content: 'never-return' },
                      },
                  }
        );
        const result = await client.callTool({
            name: 'get_source',
            arguments: {
                collectionId: 'collection-a',
                receipt: fixtureReceipt,
            },
        });
        assert.ok(isCallToolResult(result));
        assert.deepEqual(result.content, [
            { type: 'text', text: 'ACCESS_DENIED' },
        ]);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.equal(calls.length, 2);
        assert.doesNotMatch(
            JSON.stringify(result),
            /opaque-signed|private-denial|never-return/u
        );
    }
);

await test(
    'oversized valid native search content is refused whole without retry or text truncation',
    { timeout: 20_000 },
    async (t) => {
        const base = search('x'.repeat(49_152));
        const row = base.results[0];
        assert.ok(row);
        const large = {
            ...base,
            results: Array.from({ length: 6 }, (_, index) => ({
                ...row,
                id: `child-${index}`,
                parentContext: {
                    id: `parent-${index}`,
                    ordinal: index,
                    text: 'y'.repeat(49_152),
                    startOffset: 0,
                    endOffset: 49_152,
                    tokenCount: 100,
                    tokenCountIsEstimate: true,
                    sourceSpans: [],
                    sourceSpansTruncated: false,
                },
            })),
        };
        const { client, calls } = await connectFixture(t, () => ({
            output: large,
        }));
        const result = await client.callTool({
            name: 'search_collection',
            arguments: {
                collectionId: 'collection-a',
                query: 'question',
                topK: 6,
            },
        });
        assert.ok(isCallToolResult(result));
        assert.equal(result.isError, true);
        assert.deepEqual(result.content, [
            { type: 'text', text: 'OUTPUT_TOO_LARGE' },
        ]);
        assert.equal(result.structuredContent, undefined);
        assert.equal(calls.length, 1);
    }
);

await test(
    'the same serving factory supports legacy stdio clients without exposing extra tools',
    { timeout: 20_000 },
    async (t) => {
        const { client, calls } = await connectFixture(
            t,
            () => {
                throw new Error('No HTTP expected');
            },
            'collection-a',
            false
        );
        const tools = await client.listTools();
        assert.equal(tools.tools.length, 3);
        assert.equal(calls.length, 0);
    }
);
