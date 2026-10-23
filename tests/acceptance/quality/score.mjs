#!/usr/bin/env node
/** Offline scoring only. No provider, authentication, database or service startup. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadFixtures, boundedJson } from './fixture-loader.mjs';
import { evaluateCapture } from './evaluate.mjs';

const args = process.argv.slice(2);
assert(
    args.length === 4 && args[0] === '--capture' && args[2] === '--report',
    'Usage: node score.mjs --capture CAPTURE.json --report REPORT.json'
);
const capturePath = resolve(args[1]);
const reportPath = resolve(args[3]);
assert(capturePath !== reportPath, 'REPORT_MUST_NOT_OVERWRITE_CAPTURE');
const fixtures = await loadFixtures();
const capture = await boundedJson(
    capturePath,
    fixtures.policy.captureLimits.bytes
);
const report = evaluateCapture(fixtures, capture);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
});
console.log(
    JSON.stringify({
        status: report.status,
        qualityGatesStatus: report.qualityGatesStatus,
        corpusDigest: report.corpusDigest,
        expectedQueryCells: report.expectedQueryCells,
        observedQueryCells: report.observedQueryCells,
        missingEvidence: report.missingEvidence,
        hardViolations: report.hardViolations,
        capacityAcceptance: 'NOT_RUN',
        hostedProviderAcceptance: 'NOT_RUN',
    })
);
if (report.status === 'FAIL') process.exitCode = 1;
