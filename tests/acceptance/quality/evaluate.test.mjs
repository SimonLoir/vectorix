import { test as nativeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    evaluateCapture,
    sha256,
    safeOffset,
    validateFixtures,
} from './evaluate.mjs';
import { loadFixtures, BASE } from './fixture-loader.mjs';
import { syntheticCapture, replaceRange } from './synthetic-test-helper.mjs';

const fixtures = await loadFixtures();
const statistics = { tests: 0, passed: 0, failed: 0 };
function test(name, callback) {
    statistics.tests++;
    nativeTest(name, async () => {
        try {
            await callback();
            statistics.passed++;
        } catch (error) {
            statistics.failed++;
            throw error;
        }
    });
}
after(() => {
    console.log(
        JSON.stringify({
            evidenceKind: 'SYNTHETIC_UNIT_TEST',
            ...statistics,
            corpusDigest: fixtures.manifest.corpusDigest,
            nativeQualityAcceptance: 'NOT_RUN',
            providerCalls: 0,
            databaseCalls: 0,
            httpCalls: 0,
        })
    );
});

const run = (edit = () => {}) => {
    const capture = syntheticCapture(fixtures);
    edit(capture);
    return evaluateCapture(fixtures, capture);
};
const codes = (result) => result.hardViolations.map((item) => item.code);

test('24 source originals and canonical hashes are balanced and exact', async () => {
    validateFixtures(fixtures);
    for (const doc of fixtures.manifest.documents) {
        const bytes = await readFile(`${BASE}/${doc.originalPath}`);
        assert.equal(bytes.length, doc.originalBytes);
        assert.equal(sha256(bytes), doc.originalSha256);
    }
    for (const media of new Set(
        fixtures.manifest.documents.map((doc) => doc.mediaType)
    )) {
        const docs = fixtures.manifest.documents.filter(
            (doc) => doc.mediaType === media
        );
        assert.equal(docs.length, 6);
        assert.equal(docs.filter((doc) => doc.language === 'FR').length, 3);
    }
    assert.equal(
        fixtures.manifest.documents.filter(
            (doc) =>
                doc.extractionFormat === 'PDF' &&
                fixtures.artifacts[doc.fixtureId].sources.length >= 2
        ).length,
        6
    );
    assert.equal(
        fixtures.manifest.documents.filter(
            (doc) =>
                doc.extractionFormat === 'DOCX' &&
                fixtures.artifacts[doc.fixtureId].sources.some(
                    (source) => source.kind === 'docx-paragraph'
                )
        ).length,
        6
    );
});

test('40 frozen final queries, 8 separate development queries and fixed category denominators', () => {
    assert.equal(fixtures.queries.length, 40);
    assert.equal(fixtures.development.length, 8);
    assert(
        fixtures.development.every(
            (query) =>
                !query.scored &&
                !fixtures.queries.some((scored) => scored.id === query.id)
        )
    );
    for (const category of ['EXACT', 'PARAPHRASE', 'FILTER', 'PARENT'])
        assert.equal(
            fixtures.queries.filter((query) => query.category === category)
                .length,
            10
        );
    assert.equal(
        fixtures.queries.filter((query) => query.crossLanguage).length,
        4
    );
    assert(
        fixtures.qrels.every(
            (label) =>
                label.editions.length >= 1 &&
                label.factDenominator ===
                    (label.queryId.slice(1, 3) >= '16' ? 2 : 1)
        )
    );
});

test('UTF16 code units differ from UTF8 bytes and reject cutting an astral pair', () => {
    const artifact = fixtures.artifacts['m7c-f03-fr-v1'];
    const index = artifact.text.indexOf('🧭');
    assert(artifact.text.includes('cafe\u0301'));
    assert.notEqual(artifact.text.length, Buffer.byteLength(artifact.text));
    assert(safeOffset(artifact.text, index));
    assert(!safeOffset(artifact.text, index + 1));
    assert(safeOffset(artifact.text, index + 2));
});

test('EXACT keyword searches have both AND terms in an eligible canonical edition before any model run', () => {
    for (const query of fixtures.queries.filter(
        (item) => item.category === 'EXACT'
    )) {
        const match = /^"([A-Z\d-]+)" ([\p{L}]+)$/u.exec(query.text);
        assert(
            match,
            'exact lookup must be an intentional identifier+literal keyword'
        );
        const label = fixtures.qrels.find((item) => item.queryId === query.id);
        assert(
            label.editions.some((edition) => {
                const text =
                    fixtures.artifacts[edition.fixtureId].text.toLowerCase();
                return (
                    text.includes(match[1].toLowerCase()) &&
                    text.includes(match[2].toLowerCase())
                );
            })
        );
    }
});

test('perfect synthetic scorer fixture never establishes live/native/capacity acceptance', () => {
    const result = run();
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.qualityGatesStatus, 'PASS');
    assert.equal(result.hardSafetyStatus, 'PASS');
    assert.equal(result.observedQueryCells, 720);
    assert.equal(result.capacityAcceptance, 'NOT_RUN');
    assert.equal(result.hostedProviderAcceptance, 'NOT_RUN');
    assert(result.gates.every((gate) => gate.pass && gate.hybridHit5 === 40));
});

test('empty prepared capture keeps all fixed denominators and cannot pass', () => {
    const result = run((capture) => {
        capture.evidenceKind = 'PREPARED';
        capture.runs = [];
        capture.accessChecks = [];
    });
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.qualityGatesStatus, 'INCONCLUSIVE');
    assert(
        result.cells.every(
            (cell) =>
                cell.queryDenominator === 40 &&
                cell.notRun === 40 &&
                cell.mrr10 === 0
        )
    );
    assert(result.missingEvidence.includes('ACCESS_CHECKS'));
});

test('one missing run remains a miss in denominator and blocks evidence completeness', () => {
    const result = run((capture) => capture.runs.shift());
    assert.equal(result.qualityGatesStatus, 'INCONCLUSIVE');
    assert.equal(result.cells[0].queryDenominator, 40);
    assert.equal(result.cells[0].hit5, 39);
    assert.equal(result.cells[0].notRun, 1);
});

test('real request errors in comparator mode cannot be hidden by good hybrid scores', () => {
    const result = run((capture) => {
        const target = capture.runs.find(
            (item) => item.searchStrategy === 'VECTOR'
        );
        Object.assign(target, {
            status: 'ERROR',
            errorCode: 'PROVIDER_TIMEOUT',
            results: [],
        });
    });
    assert.equal(result.qualityGatesStatus, 'FAIL');
    assert.equal(
        result.cells.reduce((sum, cell) => sum + cell.errors, 0),
        1
    );
});

test('all repeats and all independent chunkers are required, no best-run cherry-picking', () => {
    const result = run((capture) => {
        for (const row of capture.runs)
            if (
                row.chunkStrategy === 'SEMANTIC' &&
                row.searchStrategy === 'HYBRID' &&
                row.repeat === 2
            )
                row.results = [];
    });
    assert.equal(result.qualityGatesStatus, 'FAIL');
    assert(
        !result.gates.find(
            (gate) => gate.chunkStrategy === 'SEMANTIC' && gate.repeat === 2
        ).pass
    );
    assert(
        result.gates.find(
            (gate) => gate.chunkStrategy === 'SEMANTIC' && gate.repeat === 1
        ).pass
    );
});

test('raw rank six counts MRR1/6 and fact coverage but misses Hit@5', () => {
    const result = run((capture) => {
        const target = capture.runs[0];
        const irrelevant = [
            'm7c-f02-en-v1',
            'm7c-f03-en-v1',
            'm7c-f04-en-v1',
            'm7c-f05-en-v1',
            'm7c-f06-en-v1',
        ].map((id) => `${target.chunkStrategy}/${id}/primary`);
        target.results = [...irrelevant, target.results[0]];
    });
    const item = result.queryScores[0];
    assert.equal(item.firstRelevantRank, 6);
    assert.equal(item.reciprocalRank10, 1 / 6);
    assert.equal(item.hit5, false);
    assert.equal(item.factRecall10, 1);
});

test('translated editions do not inflate logical-fact recall denominator', () => {
    const result = run((capture) => {
        const target = capture.runs[0];
        target.results = [
            `${target.chunkStrategy}/m7c-f01-en-v1/primary`,
            `${target.chunkStrategy}/m7c-f01-fr-v1/primary`,
        ];
    });
    assert.equal(result.queryScores[0].factDenominator, 1);
    assert.equal(result.queryScores[0].factRecall10, 1);
});

test('parent success requires both anchors in one attached parent and a relevant matched child', () => {
    const result = run((capture) => {
        for (const passage of capture.passages)
            if (passage.fixtureId.startsWith('m7c-f06-')) {
                const artifact = fixtures.artifacts[passage.fixtureId];
                replaceRange(
                    passage.parentContext,
                    artifact,
                    passage.startOffset,
                    passage.endOffset
                );
            }
    });
    const parentScores = result.queryScores.filter((item) =>
        item.queryId.startsWith('Q16')
    );
    assert(
        parentScores.every(
            (item) => item.parentHit5 === false && item.factRecall10 === 0.5
        )
    );
    assert(!codes(result).includes('PARENT_ASSOCIATION_MISMATCH'));
});

test('topic-only child with full answer-bearing parent is not a relevant match', () => {
    const result = run((capture) => {
        for (const passage of capture.passages)
            if (passage.fixtureId.startsWith('m7c-f06-')) {
                replaceRange(
                    passage,
                    fixtures.artifacts[passage.fixtureId],
                    0,
                    5
                );
            }
    });
    assert(
        result.queryScores
            .filter((item) => item.queryId.startsWith('Q16'))
            .every((item) => !item.hit5 && item.factRecall10 === 0)
    );
});

test('filter leakage fails even when a later result answers the question', () => {
    const result = run((capture) => {
        const target = capture.runs.find((item) => item.queryId === 'Q11-EN');
        target.results.unshift(`${target.chunkStrategy}/m7c-d01-en-v1/primary`);
    });
    assert(codes(result).includes('FILTER_VIOLATION'));
    assert.equal(result.hardSafetyStatus, 'FAIL');
});

test('requested filters/query/topK are bound, not inferred from coincidentally eligible results', () => {
    const result = run((capture) => {
        capture.runs.find((item) => item.queryId === 'Q15-EN').filters = {};
    });
    assert(codes(result).includes('REQUEST_DEFINITION_MISMATCH'));
});

test('wrong organization, generation or exact version is a hard safety failure', () => {
    for (const field of ['organizationId', 'generationId', 'version']) {
        const result = run((capture) => {
            capture.passages[0][field] = field === 'version' ? 2 : 'foreign';
        });
        assert(codes(result).includes('CONTENT_SCOPE_OR_VERSION_MISMATCH'));
    }
});

test('canonical text, original source hash and source provenance are independently checked', () => {
    assert(
        codes(
            run((capture) => {
                capture.passages[0].text += '!';
            })
        ).includes('CANONICAL_TEXT_MISMATCH')
    );
    assert(
        codes(
            run((capture) => {
                capture.sourceProofs[0].originalSha256 = '0'.repeat(64);
            })
        ).includes('EXACT_SOURCE_HASH_MISMATCH')
    );
    assert(
        codes(
            run((capture) => {
                capture.passages[0].sourceSpans[0].source.index += 1;
            })
        ).includes('SOURCE_PROVENANCE_MISMATCH')
    );
});

test('missing exact-source evidence remains unknown instead of a successful zero', () => {
    const result = run((capture) => {
        capture.sourceProofs.pop();
    });
    assert.equal(result.qualityGatesStatus, 'INCONCLUSIVE');
    assert(result.missingEvidence.includes('EXACT_SOURCE_PROOF'));
});

test('PDF page and DOCX paragraph provenance are preserved, not fabricated', () => {
    const pdf = fixtures.manifest.documents.find(
        (doc) => doc.extractionFormat === 'PDF'
    );
    const docx = fixtures.manifest.documents.find(
        (doc) => doc.extractionFormat === 'DOCX'
    );
    assert(
        fixtures.artifacts[pdf.fixtureId].sources.every(
            (source) =>
                source.kind === 'pdf-page' && source.page === source.index + 1
        )
    );
    assert(
        fixtures.artifacts[docx.fixtureId].sources.every(
            (source) =>
                source.kind === 'docx-paragraph' && source.page === undefined
        )
    );
});

test('splitting an astral UTF16 pair and substituting UTF8 offsets is rejected', () => {
    const result = run((capture) => {
        const passage = capture.passages.find(
            (item) => item.fixtureId === 'm7c-f03-fr-v1'
        );
        const artifact = fixtures.artifacts[passage.fixtureId];
        passage.startOffset = artifact.text.indexOf('🧭') + 1;
        passage.endOffset = passage.startOffset + 2;
        passage.text = artifact.text.slice(
            passage.startOffset,
            passage.endOffset
        );
    });
    assert(codes(result).includes('INVALID_CANONICAL_RANGE'));
});

test('native weights digest, full768 dimensions and saved algorithm identity are all required', () => {
    for (const edit of [
        (profile) => {
            profile.model.digest = '0'.repeat(64);
        },
        (profile) => {
            profile.model.dimensions = 128;
        },
        (profile) => {
            profile.chunkerVersion = 'future-version';
        },
        (profile) => {
            profile.parentContextVersion = 'future-parent';
        },
        (profile) => {
            profile.profile.preparation = 'unreviewed prefix';
        },
        (profile) => {
            profile.profile.indexType = 'HNSW';
        },
    ]) {
        assert(
            codes(run((capture) => edit(capture.profiles[0]))).includes(
                'NATIVE_OR_PROFILE_IDENTITY_MISMATCH'
            )
        );
    }
});

test('old receipts after revocation and cross-organization reads must return denial with no content', () => {
    assert(
        codes(
            run((capture) => {
                capture.accessChecks.find(
                    (item) =>
                        item.kind === 'OLD_RECEIPT_AFTER_REVOCATION_DENIED'
                ).httpStatus = 200;
            })
        ).includes('DENIED_ACCESS_LEAK')
    );
    assert(
        codes(
            run((capture) => {
                capture.accessChecks.find(
                    (item) => item.kind === 'FOREIGN_ORGANIZATION_DENIED'
                ).returnedFixtureIds = ['m7c-f01-en-v1'];
            })
        ).includes('DENIED_ACCESS_LEAK')
    );
});

test('two child results for the same attached parent fail deduplication', () => {
    const result = run((capture) => {
        const first = capture.passages[0];
        const duplicate = structuredClone(first);
        duplicate.id += '-second-child';
        const doc = fixtures.manifest.documents.find(
            (item) => item.fixtureId === first.fixtureId
        );
        replaceRange(
            duplicate,
            fixtures.artifacts[first.fixtureId],
            doc.goldSpans[1].startOffset,
            doc.goldSpans[1].endOffset
        );
        capture.passages.push(duplicate);
        capture.runs[0].results.push(duplicate.id);
    });
    assert(codes(result).includes('PARENT_DEDUPLICATION_FAILURE'));
});

test('missing parent evidence is INCONCLUSIVE, without fabricated deduplication on undefined', () => {
    const result = run((capture) => {
        for (const passage of capture.passages) delete passage.parentContext;
        capture.runs[0].results = [
            'DOCUMENT_STRUCTURE/m7c-f01-en-v1/primary',
            'DOCUMENT_STRUCTURE/m7c-f01-fr-v1/primary',
        ];
    });
    assert.equal(result.qualityGatesStatus, 'INCONCLUSIVE');
    assert(result.missingEvidence.includes('PARENT_CONTEXT_EVIDENCE'));
    assert(!codes(result).includes('PARENT_DEDUPLICATION_FAILURE'));
});

test('duplicate query cells and unsanitized error responses are rejected structurally', () => {
    assert.throws(
        () => run((capture) => (capture.runs[1] = capture.runs[0])),
        /DUPLICATE_RUN_CELL/u
    );
    assert.throws(
        () =>
            run((capture) =>
                Object.assign(capture.runs[0], {
                    status: 'ERROR',
                    errorCode: 'raw secret response',
                    results: [],
                })
            ),
        /UNSANITIZED_ERROR_CODE/u
    );
});

test('capture count, result count and byte budgets reject unbounded inputs', () => {
    assert.throws(
        () =>
            run((capture) => {
                capture.runs.push(capture.runs[0]);
            }),
        /RUN_COUNT_LIMIT/u
    );
    assert.throws(
        () =>
            run((capture) => {
                capture.runs[0].results = Array(11).fill('x');
            }),
        /RESULT_COUNT_LIMIT/u
    );
    assert.throws(
        () =>
            run((capture) => {
                capture.unused = 'x'.repeat(8 * 1024 * 1024);
            }),
        /CAPTURE_BYTE_LIMIT/u
    );
});

test('canonical/query/qrel tampering invalidates the frozen corpus digest', () => {
    const changed = structuredClone(fixtures);
    changed.queries[0].text += '?';
    assert.throws(() => validateFixtures(changed), /CORPUS_DIGEST_MISMATCH/u);
});
