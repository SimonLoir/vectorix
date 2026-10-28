# @vectorix/client

Typed API-key client for Vectorix API major 1, revision 24 or later. This package is prepared for external consumption; **npm publication has not been performed**.

The client exports the complete stable `VectorixApiV1Client` derived from the hand-written browser-safe API contracts. It imports no server router, Prisma client, authentication runtime or environment configuration. Server permissions, issuer membership, organization activity and collection scopes remain authoritative. Having a typed mutation method does not allow an API key to call a session-only operation.

## Search, context and citations

```ts
import {
    createVectorixClient,
    type RetrievalSearchInput,
} from '@vectorix/client';

const client = createVectorixClient({
    apiUrl: 'https://api.example.com',
    apiKey: 'YOUR_ORGANIZATION_API_KEY',
    organizationId: 'YOUR_ORGANIZATION_ID',
    timeoutMs: 60_000,
});

const collections = await client.admin.rag.collections.list({ limit: 10 });
const collection = collections.items.find((item) => item.permissions.read);
if (!collection) throw new Error('Select a currently readable collection.');
const input: RetrievalSearchInput = {
    collectionId: collection.id,
    query: 'How does the garden retain water?',
    strategy: 'HYBRID',
    topK: 5,
};
const signal = AbortSignal.timeout(60_000);
const search = await client.retrieval.search(input, { signal });
const hit = search.results[0];
if (hit) {
    const reference = {
        collectionId: input.collectionId,
        receipt: hit.source.receipt,
    };
    const context = await client.retrieval.context(
        { ...reference, before: 1, after: 1 },
        { signal }
    );
    const citation = await client.retrieval.citation(reference, { signal });
    console.log(
        context.passages.map(({ text }) => text),
        citation.documentName
    );
}
```

Use an organization key with `ragCollection.read`, `ragLibrary.read`, a read scope for the selected collection and a currently authorized issuer. The optional organization header only pins the key's existing organization. It does not select a foreign tenant. Store the key in your application's trusted server or CLI configuration, not in browser-delivered JavaScript. This library itself does not read environment variables.

The API URL is an absolute HTTP(S) **origin**, optionally ending in `/`. Paths, credentials, queries and fragments are rejected. The transport targets `/rpc/v1`, sends `x-api-key` and, when configured, `Vectorix-Expected-Organization-Id`. It omits ambient cookies, refuses redirects and never retries an operation automatically. HTTP is supported for an explicitly configured local test origin; use HTTPS for remote deployments.

`Vectorix-API-Version` must be exactly `1`; the revision must be a canonical nonnegative integer at least `24`. Missing or incompatible metadata fails before response content is decoded. Later compatible revisions are accepted. Types and RPC serialization, including `Date`, come from the stable public contracts; the wrapper does not validate every business DTO at runtime. Applications exposing data to another protocol should validate the particular output they expose.

## Deadlines and errors

Each call accepts the standard second `{ signal }` argument. `timeoutMs` defaults to 60,000 milliseconds and must be an integer from 1 through 120,000. The same deadline covers RPC encoding, HTTP, bounded response buffering and decoding. Pass one shared signal when several calls must fit a single overall deadline. A timeout or abort does not establish that a mutation was not admitted; inspect its native idempotency/status route before deciding whether to retry.

Responses are limited to 32 MiB of actual exposed bytes, independently of `Content-Length`, and are rejected rather than truncated. This accommodates the current 25 MiB original-file limit. The optional trusted `fetch` override must honor `Request.signal` and `redirect: 'error'`; the wrapper also rejects returned redirect responses and never returns a late result after cancellation. It cannot undo I/O performed by an override that ignores those controls.

`VectorixClientError` exposes a fixed `code`, optional HTTP `status` and a finite `serverCode`. It discards server error messages, arbitrary data, response bodies, paths and causes. For example:

```ts
import { VectorixClientError } from '@vectorix/client';

try {
    await client.retrieval.search(input);
} catch (error) {
    if (error instanceof VectorixClientError && error.status === 403) {
        // Ask an administrator to check current issuer permissions and collection scope.
    }
}
```

Exports include `VectorixApiV1Client`, `VectorixApiV1Inputs`, `VectorixApiV1Outputs`, `RetrievalSearchInput`, `RetrievalContextInput`, `RetrievalCitationInput`, `CollectionListInput`, configuration/error types and supported API/deadline/response-limit constants.

## Build and verification

From the repository root:

```sh
pnpm --filter @vectorix/client check-types
pnpm --filter @vectorix/client lint
pnpm --filter @vectorix/client test
pnpm --filter @vectorix/client build
```

Transport tests use injected Fetch implementations and an owned loopback redirect pair. They do not call a real provider or application database. The build emits ESM JavaScript and bundled declarations under `dist/`; the private workspace contract types are inlined, while public oRPC/Zod dependencies remain declared npm dependencies. Repository packaging acceptance separately installs packed artifacts in a fresh consumer and checks JavaScript execution and TypeScript resolution without the workspace.

Build tooling follows the official [tsdown declaration](https://tsdown.dev/options/dts) and [dependency bundling](https://tsdown.dev/options/dependencies) documentation. Native RPC behavior follows the installed oRPC client and its [RPC link documentation](https://orpc.dev/docs/rpc/link).
