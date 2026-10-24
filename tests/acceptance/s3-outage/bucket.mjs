/** Exact private RustFS bucket initialization; disabled and no I/O on import. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
    context,
    receiptScope,
    ROOT,
    need,
    writePrivate,
    entryError,
} from './private.mjs';

export const STATIC_DRAFT_ONLY = true;
async function main() {
    need(!STATIC_DRAFT_ONLY, 'M7C_S3_OUTAGE_BUCKET_DRAFT_REVIEW_REQUIRED');
    const { state, run, directory, recheck } = context(
        process.argv.slice(2),
        'bucket'
    );
    need(
        !fs.existsSync(path.join(directory, 'bucket-intent.json')),
        'M7C_S3_OUTAGE_BUCKET_NO_REPLAY'
    );
    writePrivate(path.join(directory, 'bucket-intent.json'), {
        ...receiptScope(state),
        status: 'STARTED_EFFECTS_UNKNOWN_UNTIL_PROOF',
    });
    const require = createRequire(path.join(ROOT, 'apps/api/package.json'));
    const sdk = require('@aws-sdk/client-s3');
    const { NodeHttpHandler } = createRequire(
        require.resolve('@aws-sdk/client-s3')
    )('@smithy/node-http-handler');
    const transport = new NodeHttpHandler({
        connectionTimeout: 2000,
        requestTimeout: 5000,
        throwOnRequestTimeout: true,
    });
    const endpoint = `http://127.0.0.1:${state.ports.rustfs}`,
        bucket = state.environment.VECTORIX_DEFAULT_S3_BUCKET;
    const deadline = performance.now() + 30000;
    const allowed = new Set([
        sdk.ListBucketsCommand,
        sdk.CreateBucketCommand,
        sdk.HeadBucketCommand,
        sdk.GetBucketVersioningCommand,
        sdk.ListObjectsV2Command,
    ]);
    const handler = {
        async handle(request, options) {
            need(
                request.protocol === 'http:' &&
                    request.hostname === '127.0.0.1' &&
                    Number(request.port) === state.ports.rustfs,
                'M7C_S3_OUTAGE_S3_ENDPOINT'
            );
            const result = await transport.handle(request, options);
            need(
                result.response.statusCode < 300 ||
                    result.response.statusCode >= 400,
                'M7C_S3_OUTAGE_S3_REDIRECT'
            );
            if (result.response.body) {
                const original = result.response.body;
                let size = 0;
                const bounded = new Transform({
                    transform(part, _encoding, callback) {
                        size += part.byteLength;
                        if (size > 65536) callback(new Error('bounded'));
                        else callback(null, part);
                    },
                });
                original.on('error', () =>
                    bounded.destroy(new Error('bounded'))
                );
                bounded.on('error', () => {});
                bounded.on('close', () => {
                    if (!original.destroyed) original.destroy();
                });
                result.response.body = original.pipe(bounded);
            }
            return result;
        },
        destroy: () => transport.destroy(),
        updateHttpClientConfig: (k, v) =>
            transport.updateHttpClientConfig(k, v),
        httpHandlerConfigs: () => transport.httpHandlerConfigs(),
    };
    const client = new sdk.S3Client({
        endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        maxAttempts: 1,
        followRegionRedirects: false,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        credentials: {
            accessKeyId: state.environment.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID,
            secretAccessKey:
                state.environment.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY,
        },
        requestHandler: handler,
    });
    async function send(Command, input) {
        need(
            allowed.has(Command) && performance.now() < deadline,
            'M7C_S3_OUTAGE_S3_OPERATION_BOUNDS'
        );
        const response = await client.send(new Command(input), {
            abortSignal: AbortSignal.timeout(
                Math.max(
                    1,
                    Math.min(5000, Math.floor(deadline - performance.now()))
                )
            ),
        });
        need(
            response.$metadata?.httpStatusCode === 200,
            'M7C_S3_OUTAGE_S3_STATUS'
        );
        return response;
    }
    try {
        const before = await send(sdk.ListBucketsCommand, {});
        need(
            (before.Buckets ?? []).length === 0,
            'M7C_S3_OUTAGE_EMPTY_OWNED_STORE_REQUIRED'
        );
        await send(sdk.CreateBucketCommand, { Bucket: bucket });
        await send(sdk.HeadBucketCommand, { Bucket: bucket });
        const versioning = await send(sdk.GetBucketVersioningCommand, {
            Bucket: bucket,
        });
        need(
            versioning.Status === undefined &&
                versioning.MFADelete === undefined,
            'M7C_S3_OUTAGE_UNVERSIONED_BUCKET'
        );
        const objects = await send(sdk.ListObjectsV2Command, {
            Bucket: bucket,
            MaxKeys: 1,
        });
        need(
            (objects.Contents ?? []).length === 0 &&
                objects.IsTruncated !== true,
            'M7C_S3_OUTAGE_EMPTY_BUCKET'
        );
        const inventory = await send(sdk.ListBucketsCommand, {});
        need(
            inventory.Buckets?.length === 1 &&
                inventory.Buckets[0].Name === bucket,
            'M7C_S3_OUTAGE_EXACT_BUCKET_INVENTORY'
        );
        const anonymous = await fetch(
            endpoint + '/' + bucket + '?list-type=2&max-keys=1',
            { redirect: 'manual', signal: AbortSignal.timeout(5000) }
        );
        void anonymous.body?.cancel().catch(() => {});
        need(
            [401, 403].includes(anonymous.status),
            'M7C_S3_OUTAGE_BUCKET_NOT_PRIVATE'
        );
        recheck();
        writePrivate(path.join(directory, 'bucket-proof.json'), {
            ...receiptScope(state),
            bucketCount: 1,
            empty: true,
            anonymousListStatus: anonymous.status,
            scope: 'INITIAL_OWNED_BUCKET_ONLY',
        });
        console.log(
            JSON.stringify({
                ...receiptScope(state),
                completed: true,
                operation: 'bucket',
                runId: run,
            })
        );
    } finally {
        client.destroy();
    }
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
