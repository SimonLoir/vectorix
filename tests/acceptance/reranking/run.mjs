#!/usr/bin/env node
/** Explicit opt-in API calls only; never loads .env, creates credentials or enables a profile. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedJson, loadFixtures } from '../quality/fixture-loader.mjs';
import { resolvedFilters } from '../quality/evaluate.mjs';
import {
    EVALUATION_TOP_K,
    evaluateResponse,
    evaluationQueries,
    summarize,
    validateBindings,
} from './evaluate.mjs';

/** Two explicit declarations guard a potentially billable test; the caller supplies a limited synthetic-tenant key. */
export function evaluationEnvironment(environment) {
    assert.equal(
        environment.VECTORIX_RERANK_EVAL_RUN,
        '1',
        'EXPLICIT_RUN_REQUIRED'
    );
    assert.equal(
        environment.VECTORIX_RERANK_EVAL_TEST_SCOPE,
        '1',
        'EXPLICIT_TEST_SCOPE_REQUIRED'
    );
    const endpoint = new URL(environment.VECTORIX_RERANK_EVAL_ENDPOINT);
    assert(
        !endpoint.username &&
            !endpoint.password &&
            !endpoint.search &&
            !endpoint.hash,
        'CLEAN_ENDPOINT_REQUIRED'
    );
    assert(
        endpoint.protocol === 'https:' ||
            (endpoint.protocol === 'http:' &&
                ['127.0.0.1', 'localhost', '[::1]'].includes(
                    endpoint.hostname
                )),
        'HTTPS_OR_LOOPBACK_REQUIRED'
    );
    const key = environment.VECTORIX_RERANK_EVAL_API_KEY;
    assert(
        typeof key === 'string' &&
            key.trim().length > 0 &&
            key.length <= 4096 &&
            /^[\x21-\x7e]+$/u.test(key),
        'LIMITED_API_KEY_REQUIRED'
    );
    const corpusDigest = environment.VECTORIX_RERANK_EVAL_CORPUS_SHA256;
    assert(
        /^[a-f0-9]{64}$/u.test(corpusDigest ?? ''),
        'DECLARED_CORPUS_REQUIRED'
    );
    const revision = Number(environment.VECTORIX_RERANK_EVAL_PROFILE_REVISION);
    assert(
        Number.isSafeInteger(revision) && revision > 0,
        'DECLARED_PROFILE_REVISION_REQUIRED'
    );
    return { endpoint, key, corpusDigest, revision };
}

/** Curl receives secrets on stdin, with no shell, curlrc, proxy inheritance, redirects or automatic retries. */
export function curlJson(url, key, body, execute = spawnSync) {
    const lines = [
        'silent',
        'show-error',
        'max-time = 65',
        'connect-timeout = 10',
        'max-filesize = 2097152',
        'proxy = ""',
        'proto = "=http,https"',
        'proto-redir = "-all"',
        `url = ${JSON.stringify(url.href)}`,
        `request = ${JSON.stringify(body ? 'POST' : 'GET')}`,
        `header = ${JSON.stringify(`x-api-key: ${key}`)}`,
        `header = ${JSON.stringify('content-type: application/json')}`,
        `write-out = ${JSON.stringify('\n%{http_code}')}`,
    ];
    if (body)
        lines.push(`data-binary = ${JSON.stringify(JSON.stringify(body))}`);
    const result = execute('curl', ['-q', '--config', '-'], {
        input: lines.join('\n') + '\n',
        encoding: 'utf8',
        timeout: 70_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    assert(!result.error && result.status === 0, 'API_TRANSPORT_FAILED');
    const boundary = result.stdout.lastIndexOf('\n');
    assert(
        boundary >= 0 && result.stdout.slice(boundary + 1) === '200',
        'API_REQUEST_REFUSED'
    );
    return JSON.parse(result.stdout.slice(0, boundary));
}

function sibling(endpoint, name) {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/reranked-search$/u, name);
    return url;
}

async function assertVacantReport(reportPath) {
    try {
        await lstat(reportPath);
    } catch (error) {
        assert(error?.code === 'ENOENT', 'REPORT_PATH_UNAVAILABLE');
        return;
    }
    assert.fail('REPORT_ALREADY_EXISTS');
}

/** No report is emitted from partial or invalid evidence; raw API responses remain only in memory. */
export async function runEvaluation({
    environment,
    bindingPath,
    reportPath,
    transport = curlJson,
}) {
    const settings = evaluationEnvironment(environment);
    assert(
        resolve(bindingPath) !== resolve(reportPath),
        'REPORT_MUST_NOT_OVERWRITE_BINDING'
    );
    await assertVacantReport(reportPath);
    const fixtures = await loadFixtures();
    const queries = evaluationQueries(fixtures);
    const binding = await boundedJson(bindingPath, 64 * 1024);
    const adapters = validateBindings(
        fixtures,
        binding,
        settings.corpusDigest,
        settings.revision
    );
    assert.equal(
        settings.endpoint.pathname,
        `/api/v1/admin/rag/collections/${binding.collectionId}/reranked-search`,
        'EXACT_VERSIONED_SEARCH_ENDPOINT_REQUIRED'
    );
    const profile = await transport(
        sibling(settings.endpoint, 'reranking'),
        settings.key
    );
    assert(
        profile.enabled &&
            profile.canUse &&
            profile.revision === settings.revision &&
            profile.configuration?.provider === binding.provider &&
            profile.configuration.model === binding.model &&
            profile.configuration.candidatePool === binding.candidatePool,
        'CURRENT_PROFILE_PREFLIGHT'
    );
    const status = await transport(
        sibling(settings.endpoint, 'index-status'),
        settings.key
    );
    assert(
        status.canRead &&
            status.active?.id === binding.generationId &&
            status.active.status === 'ACTIVE',
        'CURRENT_GENERATION_PREFLIGHT'
    );
    const cells = [];
    for (const query of queries) {
        const response = await transport(settings.endpoint, settings.key, {
            collectionId: binding.collectionId,
            query: query.text,
            topK: EVALUATION_TOP_K,
            strategy: 'HYBRID',
            filters: resolvedFilters(query, adapters.byFixture),
            requestId: randomUUID(),
            expectedRerankRevision: settings.revision,
            compare: true,
        });
        cells.push(
            evaluateResponse(fixtures, query, response, binding, adapters)
        );
    }
    const report = {
        schemaVersion: 1,
        suite: 'reranking-reference-v1-paraphrase',
        status: 'COMPLETE_OBSERVATION',
        corpusDigest: settings.corpusDigest,
        bindingSha256: createHash('sha256')
            .update(JSON.stringify(binding))
            .digest('hex'),
        profileRevision: settings.revision,
        provider: binding.provider,
        model: binding.model,
        candidateLimit: binding.candidatePool,
        topK: EVALUATION_TOP_K,
        apiCalls: queries.length + 2,
        queryCount: cells.length,
        hostedProviderAcceptance: 'NOT_ATTESTED',
        defaultChange: 'NOT_REQUESTED',
        summary: summarize(cells),
        cells,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
    });
    return report;
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        const args = process.argv.slice(2);
        assert(
            args.length === 4 &&
                args[0] === '--bindings' &&
                args[2] === '--report',
            'Usage: node run.mjs --bindings PRIVATE.json --report NEW.json'
        );
        const report = await runEvaluation({
            environment: process.env,
            bindingPath: args[1],
            reportPath: args[3],
        });
        console.log(
            JSON.stringify({
                status: report.status,
                queries: report.queryCount,
                corpusDigest: report.corpusDigest,
                hostedProviderAcceptance: report.hostedProviderAcceptance,
            })
        );
    } catch {
        // Do not print assertion values, curl stderr, responses, destinations or keys.
        console.error(
            'RERANK_EVALUATION_FAILED: no complete report was written. Check the private setup, declared bindings and API access.'
        );
        process.exitCode = 1;
    }
}
