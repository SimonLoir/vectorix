/** Bounded synthetic Ollama-protocol fixture. It has no weights, provider key or outbound I/O. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    context,
    need,
    receiptScope,
    writePrivate,
    entryError,
} from './private.mjs';
export const STATIC_DRAFT_ONLY = true;
export const MODEL = 'vector-outage-synthetic:latest';
export const MODEL_DIGEST = 'c'.repeat(64);
export const PROFILE = Object.freeze({
    provider: 'OLLAMA',
    model: MODEL,
    dimensions: 3,
    metric: 'cosine',
    indexType: 'HNSW',
    numericType: 'float32',
    preparation: '',
    embeddingPreset: 'GENERIC',
    metadataFields: {},
    chunkingStrategy: 'DOCUMENT_STRUCTURE',
    chunking: {
        targetTokens: 512,
        overlapTokens: 64,
        minTokens: 128,
        maxTokens: 768,
        semanticPercentile: 90,
        parentMaxTokens: 2048,
    },
    parentChild: true,
});
/** Admit at most 128 lifetime connections and 16 simultaneously; a saturated counter never wraps. */
export function admitSyntheticConnection(counters, active) {
    need(
        Number.isSafeInteger(counters.connections) &&
            counters.connections >= 0 &&
            Number.isSafeInteger(active) &&
            active >= 0,
        'S3_OUTAGE_VECTOR_FIXTURE_CONNECTION'
    );
    counters.connections = Math.min(129, counters.connections + 1);
    return counters.connections <= 128 && active < 16;
}
/** Integer nonzero vectors are deterministic transport fixtures, never retrieval-quality evidence. */
export function syntheticVector(text) {
    const hash = createHash('sha256').update(text).digest();
    return [1 + (hash[0] % 7), 1 + (hash[1] % 7), 1 + (hash[2] % 7)];
}
export function syntheticResponse(method, route, body) {
    need(
        (method === 'GET' && route === '/api/tags') ||
            (method === 'POST' && ['/api/show', '/api/embed'].includes(route)),
        'S3_OUTAGE_VECTOR_FIXTURE_ROUTE'
    );
    if (route === '/api/tags') {
        need(body === null, 'S3_OUTAGE_VECTOR_FIXTURE_BODY');
        return {
            models: [
                {
                    name: MODEL,
                    model: MODEL,
                    digest: MODEL_DIGEST,
                    details: { family: 'bert' },
                },
            ],
        };
    }
    need(body && body.model === MODEL, 'S3_OUTAGE_VECTOR_FIXTURE_MODEL');
    if (route === '/api/show') {
        need(
            Object.keys(body).sort().join(',') === 'model,verbose' &&
                body.verbose === false,
            'S3_OUTAGE_VECTOR_FIXTURE_BODY'
        );
        return {
            details: { family: 'bert' },
            capabilities: ['embedding'],
            model_info: {
                'general.architecture': 'bert',
                'bert.context_length': 2048,
                'bert.embedding_length': 3,
            },
        };
    }
    const embedShape = Object.keys(body).sort().join(',');
    need(
        (embedShape === 'input,model,truncate' ||
            (embedShape === 'dimensions,input,model,truncate' &&
                body.dimensions === 3)) &&
            body.truncate === false &&
            Array.isArray(body.input) &&
            body.input.length >= 1 &&
            body.input.length <= 16 &&
            body.input.every(
                (text) =>
                    typeof text === 'string' &&
                    text.length > 0 &&
                    Buffer.byteLength(text) <= 4096
            ) &&
            Buffer.byteLength(JSON.stringify(body)) <= 16384,
        'S3_OUTAGE_VECTOR_FIXTURE_BODY'
    );
    return {
        model: MODEL,
        embeddings: body.input.map(syntheticVector),
        prompt_eval_count: body.input.reduce(
            (sum, text) => sum + Math.ceil(Buffer.byteLength(text) / 4),
            0
        ),
    };
}
async function main() {
    need(!STATIC_DRAFT_ONLY, 'S3_OUTAGE_VECTOR_FIXTURE_DRAFT_REVIEW_REQUIRED');
    const { state, directory, recheck } = context(
        process.argv.slice(2),
        'embedding'
    );
    need(
        state.scenario === 'VECTOR_PROVISION_V1' &&
            state.processes.embedding.pid === process.pid,
        'S3_OUTAGE_VECTOR_FIXTURE_SCOPE'
    );
    const sockets = new Set(),
        counters = {
            requests: 0,
            embeddings: 0,
            inputs: 0,
            rejected: 0,
            connections: 0,
        };
    const deadline = performance.now() + 2700000;
    let active = 0,
        closing = false;
    const server = http.createServer(async (req, res) => {
        active++;
        counters.requests++;
        try {
            need(
                !closing &&
                    performance.now() < deadline &&
                    counters.requests <= 128 &&
                    active <= 4,
                'S3_OUTAGE_VECTOR_FIXTURE_BOUND'
            );
            recheck();
            const parts = [];
            let bytes = 0;
            for await (const part of req) {
                bytes += part.length;
                need(bytes <= 16384, 'S3_OUTAGE_VECTOR_FIXTURE_BOUND');
                parts.push(part);
            }
            const body = bytes
                ? JSON.parse(Buffer.concat(parts).toString('utf8'))
                : null;
            const result = syntheticResponse(req.method, req.url, body);
            recheck();
            if (req.url === '/api/embed') {
                counters.embeddings++;
                counters.inputs += body.input.length;
            }
            res.writeHead(200, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
            });
            res.end(JSON.stringify(result));
        } catch {
            counters.rejected++;
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{"error":"synthetic request refused"}');
        } finally {
            active--;
        }
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.timeout = 5000;
    server.keepAliveTimeout = 1000;
    server.maxRequestsPerSocket = 16;
    server.on('connection', (socket) => {
        if (!admitSyntheticConnection(counters, sockets.size)) {
            socket.destroy();
            if (counters.connections > 128) stop();
        } else {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        }
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    const stop = () => {
        if (closing) return;
        closing = true;
        server.close(() => {
            try {
                writePrivate(path.join(directory, 'embedding-final.json'), {
                    ...receiptScope(state),
                    synthetic: true,
                    counters,
                });
            } catch (error) {
                entryError(error);
            }
        });
        for (const socket of sockets) socket.destroy();
    };
    const timer = setTimeout(stop, 2700000);
    timer.unref();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(state.ports.embedding, '127.0.0.1', resolve);
    });
    recheck();
    writePrivate(path.join(directory, 'embedding-ready.json'), {
        ...receiptScope(state),
        port: state.ports.embedding,
        synthetic: true,
    });
    // No raw requests, cookies, inputs or provider responses are logged.
    fs.writeSync(
        1,
        JSON.stringify({
            ...receiptScope(state),
            completed: true,
            operation: 'synthetic-embedding-ready',
        }) + '\n'
    );
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
