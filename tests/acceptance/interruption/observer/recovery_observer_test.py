"""Synthetic offline invariants only; never a live interruption/native/physical proof."""
from __future__ import annotations

import copy
import json
import importlib.util
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import recovery_observation as model
import recovery_observer as runtime

SCOPE = {'organizationId': 'org-A', 'collectionId': 'col-A', 'oldGenerationId': 'generation-A',
    'generationId': 'generation-B', 'documentId': 'document-A'}
EARLY, LATE, BEFORE = '2026-10-23T12:00:00+00:00', '2026-10-23T12:02:00+00:00', '2026-10-23T11:59:00+00:00'
HASH = 'a' * 64


def plan(candidate, generation, ready=False):
    count = 65
    return {'indexedDocumentId': candidate, 'organizationId': 'org-A', 'generationId': generation,
        'configurationRevision': 2 if generation.endswith('B') else 1, 'chunkerVersion': 'semantic-utf8-v1',
        'unitizerVersion': 'semantic-units-utf8-v1', 'sourceHash': HASH, 'profileHash': HASH, 'modelIdentity': HASH,
        'unitManifestHash': HASH, 'unitCount': count,
        'unitRanges': [{'ordinal': i, 'start': i * 10, 'end': (i + 1) * 10} for i in range(count)],
        'completedUnits': count if ready else 32, 'boundaryScores': [10] * (count - 1 if ready else 31),
        'state': 'READY' if ready else 'PLANNING', 'thresholdDistance': 10 if ready else None,
        'finalRanges': [{'ordinal': 0, 'start': 0, 'end': 320}, {'ordinal': 1, 'start': 320, 'end': 650}] if ready else None,
        'planHash': HASH if ready else None, 'reservedBytes': '0' if ready else '100', 'storedBytes': '100',
        'reservedPreparedBytes': '0' if ready else '50', 'reservedBatches': '0' if ready else '1',
        'revision': '2', 'sealedAt': LATE if ready else None, 'cleanedAt': None,
        'checkpointSha256': None if ready else 'a' * 64, 'checkpointBytes': None if ready else 512}


def work(identity, generation, key, state='SUCCEEDED', epoch='1', count=32):
    success = state == 'SUCCEEDED'
    return {'id': identity, 'organizationId': 'org-A', 'generationId': generation,
        'indexedDocumentId': 'candidate-' + generation[-1], 'purpose': 'BOUNDARY', 'operationKey': key,
        'batchOrdinal': 0, 'attemptNumber': 1, 'inputHash': HASH, 'inputCount': count,
        'preparedInputBytes': 100, 'taskId': 'task-' + generation[-1], 'leaseEpoch': epoch, 'state': state,
        'reservedPreparedBytes': '100' if state == 'IN_FLIGHT' else '0',
        'reservedBatches': '1' if state == 'IN_FLIGHT' else '0', 'dispatchedPreparedBytes': '100',
        'dispatchedBatches': '1', 'successfulRequests': 1 if success else None,
        'estimatedInputTokens': '25' if success else None, 'providerInputTokens': '30' if success else None,
        'billedInputTokens': None, 'createdAt': BEFORE if epoch == '1' else LATE,
        'dispatchStartedAt': BEFORE, 'deadlineAt': EARLY, 'settledAt': EARLY if success else None,
        'usageRecordedAt': EARLY if success else None, 'uncertainAt': None}


def rows(candidate, generation):
    children = [{'id': candidate + '-child-' + str(i), 'organizationId': 'org-A', 'generationId': generation,
        'indexedDocumentId': candidate, 'ordinal': i, 'kind': 'CHILD', 'parentId': candidate + '-parent',
        'startOffset': start, 'endOffset': end, 'textHash': HASH, 'embeddingInputHash': HASH, 'textBytes': end - start}
        for i, (start, end) in enumerate([(0, 320), (320, 650)])]
    return [*children, {'id': candidate + '-parent', 'organizationId': 'org-A', 'generationId': generation,
        'indexedDocumentId': candidate, 'ordinal': 2, 'kind': 'PARENT', 'parentId': None,
        'startOffset': 0, 'endOffset': 650, 'textHash': HASH, 'embeddingInputHash': None, 'textBytes': 650}]


def publication(candidate, generation, published):
    children = rows(candidate, generation)[:2]
    return {'id': candidate, 'organizationId': 'org-A', 'generationId': generation, 'documentId': 'document-A',
        'sourceVersionId': 'version-A', 'extractionId': 'extraction-A', 'extractorVersion': 'utf8-text-v1',
        'buildRevision': 1, 'metadataRevision': 1, 'status': 'PUBLISHED' if published else 'STAGING',
        'chunkCount': 2 if published else 0, 'materializedChunks': 2 if published else 0,
        'manifestHash': model.sha(model.canonical([[c['id'], c['ordinal'], c['textHash']] for c in children])) if published else None,
        'vectorSealedAt': BEFORE if published else None, 'publishedAt': BEFORE if published else None,
        'retiredAt': None, 'originalSha256': HASH, 'contentState': 'AVAILABLE', 'sourceStatus': 'READY', 'discardedAt': None}


def update_account(snapshot):
    ps, ws = snapshot['plans'], snapshot['work']
    observed = [w for w in ws if w['usageRecordedAt'] is not None]
    account = {'reservedPlanBytes': sum(int(p['reservedBytes']) for p in ps),
        'storedPlanBytes': sum(int(p['storedBytes']) for p in ps),
        'reservedPreparedBytes': sum(int(p['reservedPreparedBytes']) for p in ps) + sum(int(w['reservedPreparedBytes']) for w in ws),
        'reservedBatches': sum(int(p['reservedBatches']) for p in ps) + sum(int(w['reservedBatches']) for w in ws),
        'dispatchedPreparedBytes': sum(int(w['dispatchedPreparedBytes']) for w in ws),
        'dispatchedBatches': sum(int(w['dispatchedBatches']) for w in ws),
        'observedSuccessfulRequests': len(observed), 'observedEstimatedInputTokens': sum(int(w['estimatedInputTokens']) for w in observed),
        'observedProviderInputTokens': sum(int(w['providerInputTokens']) for w in observed if w['providerInputTokens'] is not None),
        'observedBilledInputTokens': 0, 'unknownProviderTokenBatches': sum(w['providerInputTokens'] is None for w in observed),
        'unknownBilledTokenBatches': len(observed), 'uncertainAttempts': sum(w['state'] == 'UNCERTAIN' for w in ws)}
    snapshot['embeddingAccounting'] = {k: str(v) for k, v in account.items()}
    snapshot['counts'] = {name: len(snapshot[name]) for name in model.LIMITS}
    return snapshot


def fixture():
    snapshot = {'databaseNow': BEFORE, 'globalDocuments': 1, 'globalCollections': 1, 'scopeDocument': 1,
        'sessionTimeZone': 'Etc/UTC', 'prismaTimestampTypes': dict(model.PRISMA_TIMESTAMP_TYPES),
        'activeGenerationId': 'generation-A', 'generations': [], 'publications': [], 'plans': [], 'documents': [],
        'tasks': [], 'work': [], 'chunks': rows('candidate-A', 'generation-A'), 'holds': [],
        'indexAccounting': {'activeChunks': '2', 'retainedChunks': '0', 'reservedChunks': '2'}}
    for letter in ['A', 'B']:
        generation, candidate = 'generation-' + letter, 'candidate-' + letter
        snapshot['generations'].append({'id': generation, 'organizationId': 'org-A', 'collectionId': 'col-A',
            'status': 'ACTIVE' if letter == 'A' else 'BUILDING', 'previousGenerationId': None if letter == 'A' else 'generation-A'})
        snapshot['publications'].append(publication(candidate, generation, letter == 'A'))
        snapshot['plans'].append(plan(candidate, generation, letter == 'A'))
        snapshot['documents'].append({'organizationId': 'org-A', 'generationId': generation, 'documentId': 'document-A',
            'publishedIndexedDocumentId': candidate if letter == 'A' else None, 'desiredVersionId': 'version-A',
            'desiredExtractionId': 'extraction-A', 'desiredMetadataRevision': 1, 'buildRevision': 1, 'targetChunkCount': 2})
        snapshot['tasks'].append({'id': 'task-' + letter, 'organizationId': 'org-A', 'generationId': generation,
            'indexedDocumentId': candidate, 'kind': 'INDEX_DOCUMENT', 'status': 'COMPLETE' if letter == 'A' else 'PROCESSING',
            'stage': 'COMPLETE' if letter == 'A' else 'SEMANTIC_PLANNING', 'leaseEpoch': '1',
            'leasedUntil': EARLY, 'attempts': 1, 'continuations': 1})
        snapshot['holds'].append({'organizationId': 'org-A', 'indexedDocumentId': candidate, 'versionId': 'version-A',
            'state': 'LIVE', 'retainUntil': None, 'releasedAt': None})
    snapshot['work'] = [work('accepted-A', 'generation-A', 'boundary:0'),
        work('accepted-B', 'generation-B', 'boundary:0'), work('abandoned-B', 'generation-B', 'boundary:32', 'IN_FLIGHT')]
    fault = {'status': 'WORKER_KILLED_MODEL_RESUMED', 'killed': True, 'modelResumed': True,
        'scope': {k: SCOPE[k] for k in ['organizationId', 'collectionId', 'generationId', 'documentId']},
        'caught': {'indexedDocumentId': 'candidate-B', 'taskId': 'task-B', 'leaseEpoch': '1', 'sourceHash': HASH,
            'profileHash': HASH, 'unitManifestHash': HASH, 'modelIdentity': HASH, 'unitCount': 65,
            'sourceVersionId': 'version-A', 'extractionId': 'extraction-A', 'extractorVersion': 'utf8-text-v1',
            'buildRevision': 1, 'metadataRevision': 1,
            'leasedUntil': EARLY, 'lastVectorSha256': 'a' * 64,
            'completedUnits': 32, 'boundaryScores': [10] * 31, 'inFlight': [{'id': 'abandoned-B', 'deadlineAt': EARLY}]}}
    return update_account(snapshot), fault


def phases():
    initial, fault = fixture()
    prior = {'stage': 'absent-checkpoint', 'scope': SCOPE, 'snapshot': copy.deepcopy(initial)}
    expired_snapshot = copy.deepcopy(initial)
    expired_snapshot['databaseNow'] = LATE
    expired = {'stage': 'expired-before-restart', 'scope': SCOPE, 'snapshot': expired_snapshot}
    recovered = copy.deepcopy(expired_snapshot)
    recovered['activeGenerationId'] = 'generation-B'
    recovered['generations'][0]['status'] = 'RETIRED'
    recovered['generations'][1]['status'] = 'ACTIVE'
    recovered['plans'][1] = plan('candidate-B', 'generation-B', True)
    recovered['publications'][0]['status'] = 'RETIRED'
    recovered['publications'][1] = publication('candidate-B', 'generation-B', True)
    recovered['documents'][1]['publishedIndexedDocumentId'] = 'candidate-B'
    recovered['tasks'][1].update(status='COMPLETE', leaseEpoch='2', attempts=2, continuations=2)
    abandoned = recovered['work'][2]
    abandoned.update(state='UNCERTAIN', reservedPreparedBytes='0', reservedBatches='0', uncertainAt=LATE, settledAt=LATE)
    recovered['work'] += [work('remaining-B', 'generation-B', 'boundary:32', epoch='2'),
        work('tail-B', 'generation-B', 'boundary:64', epoch='3', count=1)]
    recovered['chunks'] += rows('candidate-B', 'generation-B')
    recovered['holds'][0].update(state='RETIRED', retainUntil='2026-10-23T12:20:00+00:00')
    recovered['indexAccounting'] = {'activeChunks': '2', 'retainedChunks': '2', 'reservedChunks': '0'}
    return initial, fault, prior, expired, update_account(recovered)


class RecoveryTests(unittest.TestCase):
    def test_three_checkpoints_preserve_logical_prefix_and_report_uncertain_work(self):
        initial, fault, prior, expired, recovered = phases()
        self.assertTrue(model.assess('absent-checkpoint', initial, SCOPE, fault)['checks']['caughtPrefixPreserved'])
        result = model.assess('expired-before-restart', expired['snapshot'], SCOPE, fault, prior)
        self.assertTrue(result['checks']['naturalDeadlinesPassedWhileWorkerAbsent'])
        result = model.assess('recovered', recovered, SCOPE, fault, prior, expired)
        self.assertEqual(result['acceptedPrefixUnits'], 32)
        self.assertEqual(result['abandonedWorkState'], 'UNCERTAIN')
        self.assertEqual(result['logicalLedger']['uncertainAttempts'], '1')
        self.assertEqual(result['logicalLedger']['reservedBatches'], '0')
        self.assertEqual(result['providerWireExactlyOnce'], 'NOT_ESTABLISHED')
        self.assertEqual(result['physicalVectorAcceptance'], 'NOT_OBSERVED')

    def test_deadlines_must_pass_in_database_time_without_rewriting_them(self):
        _, fault, prior, expired, _ = phases()
        expired['snapshot']['databaseNow'] = EARLY
        with self.assertRaisesRegex(model.ObservationRefused, 'NATURAL_DEADLINE_NOT_PASSED'):
            model.assess('expired-before-restart', expired['snapshot'], SCOPE, fault, prior)

    def test_native_prisma_millisecond_deadlines_use_explicit_utc_provenance_without_rewriting(self):
        _, fault, prior, expired, _ = phases()
        native = '2026-10-23T09:20:13.121'
        for snapshot in [prior['snapshot'], expired['snapshot']]:
            snapshot['tasks'][1]['leasedUntil'] = native
            snapshot['work'][2]['deadlineAt'] = native
        fault['caught']['leasedUntil'] = native
        fault['caught']['inFlight'][0]['deadlineAt'] = native
        expired['snapshot']['databaseNow'] = '2026-10-23T09:20:13.120999+00:00'
        with self.assertRaisesRegex(model.ObservationRefused, 'NATURAL_DEADLINE_NOT_PASSED'):
            model.assess('expired-before-restart', expired['snapshot'], SCOPE, fault, prior)
        expired['snapshot']['databaseNow'] = '2026-10-23T09:20:13.121001+00:00'
        model.assess('expired-before-restart', expired['snapshot'], SCOPE, fault, prior)
        self.assertEqual(expired['snapshot']['tasks'][1]['leasedUntil'], native)
        self.assertEqual(expired['snapshot']['work'][2]['deadlineAt'], native)
        self.assertEqual(model.instant(native, prisma_utc_session='UTC').microsecond, 121000)

    def test_naive_strings_are_rejected_without_designated_utc_schema_context(self):
        for value, context in [('2026-10-23T09:20:13.121', None), ('2026-10-23T09:20:13.121', 'Europe/Brussels'),
            ('2026-10-23', 'UTC'), ('2026-10-23T09:20', 'UTC'), ('2026-10-23T09:20:13junk', 'UTC')]:
            with self.assertRaisesRegex(model.ObservationRefused, 'OBSERVER_TIMESTAMP'):
                model.instant(value, prisma_utc_session=context)
        self.assertEqual(model.instant('2026-10-23T11:20:13.121+02:00'),
            model.instant('2026-10-23T09:20:13.121', prisma_utc_session='Etc/UTC'))

    def test_non_utc_session_wrong_actual_column_type_or_naive_clock_refuses(self):
        for mutate in [lambda s: s.update(sessionTimeZone='Europe/Brussels'),
            lambda s: s['prismaTimestampTypes'].update(workDeadline='timestamp with time zone'),
            lambda s: s.update(databaseNow='2026-10-23T12:02:00')]:
            snapshot, fault = fixture()
            mutate(snapshot)
            with self.assertRaises(model.ObservationRefused):
                model.assess('absent-checkpoint', snapshot, SCOPE, fault)

    def test_recovered_native_naive_uncertain_and_retention_dates_are_schema_scoped(self):
        _, fault, prior, expired, recovered = phases()
        for snapshot in [prior['snapshot'], expired['snapshot'], recovered]:
            for task in snapshot['tasks']: task['leasedUntil'] = task['leasedUntil'].replace('+00:00', '')
            for work in snapshot['work']:
                work['deadlineAt'] = work['deadlineAt'].replace('+00:00', '')
                if work['uncertainAt'] is not None: work['uncertainAt'] = work['uncertainAt'].replace('+00:00', '')
            for hold in snapshot['holds']:
                if hold['retainUntil'] is not None: hold['retainUntil'] = hold['retainUntil'].replace('+00:00', '')
        fault['caught']['leasedUntil'] = fault['caught']['leasedUntil'].replace('+00:00', '')
        fault['caught']['inFlight'][0]['deadlineAt'] = fault['caught']['inFlight'][0]['deadlineAt'].replace('+00:00', '')
        result = model.assess('recovered', recovered, SCOPE, fault, prior, expired)
        self.assertTrue(result['checks']['BActivated'])

    def test_shortened_deadlines_or_changed_checkpoint_do_not_prove_natural_expiry(self):
        for mutate in [lambda s: s['tasks'][1].update(leasedUntil=BEFORE),
            lambda s: s['work'][2].update(deadlineAt=BEFORE),
            lambda s: s['plans'][1].update(checkpointSha256='b' * 64)]:
            _, fault, prior, expired, _ = phases()
            mutate(expired['snapshot'])
            with self.assertRaises(model.ObservationRefused):
                model.assess('expired-before-restart', expired['snapshot'], SCOPE, fault, prior)

    def test_expired_checkpoint_is_required_and_stale_epoch_cannot_prove_recovery(self):
        _, fault, prior, expired, recovered = phases()
        with self.assertRaisesRegex(model.ObservationRefused, 'EXPIRED_CHECKPOINT_REQUIRED'):
            model.assess('recovered', recovered, SCOPE, fault, prior)
        recovered['tasks'][1]['leaseEpoch'] = '1'
        with self.assertRaisesRegex(model.ObservationRefused, 'RECOVERY_NOT_COMPLETE'):
            model.assess('recovered', recovered, SCOPE, fault, prior, expired)

    def test_retired_generation_keeps_published_candidates_and_their_retained_charge(self):
        # Native 8af state shape: A RETIRED, its publication stays PUBLISHED.
        # Values here are synthetic; no application/native snapshot is copied.
        _, fault, prior, expired, recovered = phases()
        recovered['publications'][0]['status'] = 'PUBLISHED'
        result = model.assess('recovered', recovered, SCOPE, fault, prior, expired)
        self.assertTrue(result['checks']['BActivated'])
        self.assertEqual(recovered['indexAccounting']['retainedChunks'], '2')
        for status in ['CLEANING', 'CLEANED']:
            changed = copy.deepcopy(recovered)
            changed['generations'][0]['status'] = status
            with self.assertRaisesRegex(model.ObservationRefused, 'RECOVERY_GENERATIONS'):
                model.assess('recovered', changed, SCOPE, fault, prior, expired)
        recovered['indexAccounting']['retainedChunks'] = '0'
        with self.assertRaisesRegex(model.ObservationRefused, 'CHILD_ACCOUNTING'):
            model.assess('recovered', recovered, SCOPE, fault, prior, expired)

    def test_a_changed_accepted_score_or_unit_range_is_rejected(self):
        for mutate in [lambda p: p['boundaryScores'].__setitem__(0, 11),
            lambda p: p['unitRanges'][0].update(start=1)]:
            _, fault, prior, expired, recovered = phases()
            mutate(recovered['plans'][1])
            with self.assertRaisesRegex(model.ObservationRefused, 'PREFIX_CHANGED'):
                model.assess('recovered', recovered, SCOPE, fault, prior, expired)

    def test_accepted_prefix_redispatch_is_not_hidden_by_matching_final_counts(self):
        _, fault, prior, expired, recovered = phases()
        recovered['work'][3]['operationKey'] = 'boundary:0'
        with self.assertRaisesRegex(model.ObservationRefused, 'ACCEPTED_PREFIX_REDISPATCHED'):
            model.assess('recovered', recovered, SCOPE, fault, prior, expired)

    def test_all_lifetime_work_is_retained_and_accounting_is_not_native_billing(self):
        _, fault, prior, expired, recovered = phases()
        recovered['work'].pop(0)
        update_account(recovered)
        with self.assertRaisesRegex(model.ObservationRefused, 'HISTORY_CHANGED'):
            model.assess('recovered', recovered, SCOPE, fault, prior, expired)
        _, fault, prior, expired, recovered = phases()
        recovered['embeddingAccounting']['observedProviderInputTokens'] = '0'
        with self.assertRaisesRegex(model.ObservationRefused, 'EMBEDDING_ACCOUNTING'):
            model.assess('recovered', recovered, SCOPE, fault, prior, expired)

    def test_inflight_or_known_success_cannot_be_falsely_called_uncertain(self):
        for status in ['IN_FLIGHT', 'SUCCEEDED']:
            _, fault, prior, expired, recovered = phases()
            recovered['work'][2]['state'] = status
            update_account(recovered)
            with self.assertRaisesRegex(model.ObservationRefused, 'ABANDONED_OUTCOME_NOT_UNCERTAIN'):
                model.assess('recovered', recovered, SCOPE, fault, prior, expired)

    def test_cross_scope_parent_and_expired_hold_do_not_pass_final_layout(self):
        for mutate, code in [
            (lambda s: s['chunks'][-2].update(parentId='candidate-A-parent'), 'PARENT_CONTAINMENT'),
            (lambda s: s['holds'][0].update(retainUntil=EARLY), 'SOURCE_HOLD'),
            (lambda s: s['chunks'][-3].update(textHash='b' * 64), 'CHILD_MANIFEST')]:
            _, fault, prior, expired, recovered = phases()
            mutate(recovered)
            with self.assertRaisesRegex(model.ObservationRefused, code):
                model.assess('recovered', recovered, SCOPE, fault, prior, expired)

    def test_overflow_is_refused_before_returning_partial_history(self):
        snapshot, fault = fixture()
        snapshot['counts']['work'] = 129
        with self.assertRaises(model.ObservationRefused):
            model.assess('absent-checkpoint', snapshot, SCOPE, fault)

    def test_two_predeclared_255_child_44_parent_layouts_fit_but_641_rows_refuse(self):
        snapshot, _ = fixture()
        snapshot['chunks'] = []
        for letter in ['A', 'B']:
            candidate, generation = 'candidate-' + letter, 'generation-' + letter
            children = []
            for i in range(255):
                parent = i * 44 // 255
                children.append({'id': candidate + '-c' + str(i), 'organizationId': 'org-A', 'generationId': generation,
                    'indexedDocumentId': candidate, 'ordinal': i, 'kind': 'CHILD', 'parentId': candidate + '-p' + str(parent),
                    'startOffset': i * 2, 'endOffset': i * 2 + 2, 'textHash': HASH, 'embeddingInputHash': HASH, 'textBytes': 2})
            parents = []
            for i in range(44):
                members = [c for c in children if c['parentId'] == candidate + '-p' + str(i)]
                parents.append({'id': candidate + '-p' + str(i), 'organizationId': 'org-A', 'generationId': generation,
                    'indexedDocumentId': candidate, 'ordinal': 255 + i, 'kind': 'PARENT', 'parentId': None,
                    'startOffset': members[0]['startOffset'], 'endOffset': members[-1]['endOffset'],
                    'textHash': HASH, 'embeddingInputHash': None, 'textBytes': members[-1]['endOffset'] - members[0]['startOffset']})
            snapshot['chunks'] += children + parents
            publication = next(p for p in snapshot['publications'] if p['id'] == candidate)
            publication.update(chunkCount=255, materializedChunks=255,
                manifestHash=model.sha(model.canonical([[c['id'], c['ordinal'], c['textHash']] for c in children])))
        update_account(snapshot)
        model.bounded_snapshot(snapshot, SCOPE)
        self.assertEqual(len(snapshot['chunks']), 598)
        self.assertIn('LIMIT 641', model.snapshot_sql(SCOPE))
        snapshot['counts']['chunks'] = 641
        with self.assertRaises(model.ObservationRefused): model.bounded_snapshot(snapshot, SCOPE)

    def test_query_is_one_readonly_statement_and_does_not_select_secrets_or_raw_vector(self):
        sql = model.snapshot_sql(SCOPE)
        self.assertNotIn(';', sql)
        self.assertNotIn('leaseToken', sql)
        self.assertNotIn('encode(p."lastUnitVector"', sql)
        self.assertNotIn('capabilitySnapshot', sql)
        self.assertIn("encode(sha256(p.\"lastUnitVector\"),'hex')", sql)
        self.assertIn('statement_timestamp()', sql)
        self.assertIn('LIMIT 129', sql)
        for word in ['INSERT ', 'UPDATE ', 'DELETE ', 'pg_sleep', 'COPY ']: self.assertNotIn(word, sql)
        for key in SCOPE:
            scope = {**SCOPE, key: "x'; SELECT secret"}
            with self.assertRaisesRegex(model.ObservationRefused, 'SCOPE'):
                model.snapshot_sql(scope)
        quality = runtime.ROOT / 'tests/acceptance/quality'
        spec = importlib.util.spec_from_file_location('recovery_test_actual_quality', quality / 'quality-topology.py')
        reader = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'path', [str(quality), *sys.path]):
            spec.loader.exec_module(reader)
        # Exercise the real existing prefix+byte guard and command builder;
        # the only resource boundaries are mocked before invocation.
        with patch.object(reader, 'owned', return_value={'Id': 'synthetic-owned-id'}) as owned, \
            patch.object(reader, 'run', return_value=b'{"synthetic":true}') as run:
            self.assertEqual(reader.db_query({'applicationDatabase': 'synthetic_app_test'}, sql), {'synthetic': True})
            owned.assert_called_once()
            self.assertEqual(run.call_args.args[0][-1], sql)
        self.assertLessEqual(len(model.snapshot_sql({key: ('a' if key != 'oldGenerationId' else 'b') * 128 for key in SCOPE})), 16384)

    def test_disabled_entry_cannot_reach_source_or_fault_import(self):
        with patch.object(runtime, 'STATIC_DRAFT_ONLY', True), patch.object(runtime, 'verify_sources') as verify, \
            patch.object(runtime, 'fault_module') as load:
            with self.assertRaisesRegex(model.ObservationRefused, 'DISABLED'): runtime.main([])
            verify.assert_not_called()
            load.assert_not_called()
        with patch.object(runtime, 'STATIC_DRAFT_ONLY', False), patch.object(runtime, 'observe') as observe:
            with self.assertRaisesRegex(model.ObservationRefused, 'ARGUMENTS'):
                runtime.main(['--run', 'PRIVATE_ARGUMENT'])
            observe.assert_not_called()

    def test_prior_proof_is_bound_to_exact_manifest_fault_scope_and_snapshot(self):
        initial, _ = fixture()
        proof = {'schemaVersion': 1, 'runId': 'abcdef012345', 'scope': SCOPE, 'manifestSha256': HASH,
            'faultResultSha256': HASH, 'stage': 'absent-checkpoint', 'status': 'CATALOG_CHECKPOINT_RECORDED',
            'snapshot': initial, 'snapshotSha256': model.sha(model.canonical(initial))}
        runtime.proof_binding(proof, 'abcdef012345', SCOPE, HASH, HASH, 'absent-checkpoint')
        proof['snapshot']['plans'][1]['completedUnits'] += 1
        with self.assertRaisesRegex(model.ObservationRefused, 'PRIOR_PROOF'):
            runtime.proof_binding(proof, 'abcdef012345', SCOPE, HASH, HASH, 'absent-checkpoint')

    def runtime_mock(self, fail_guard=False):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            snapshot, action = fixture()
            action.update(runId='abcdef012345', bindingSha256=HASH, oldWorker={'pid': 123}, trialDeadlineMonotonicNs=100)
            action['caught']['activeGenerationId'] = SCOPE['oldGenerationId']
            calls = []
            fixture_bytes = model.canonical({'users': {'owner': {'organizationId': 'org-A'}}})
            def read(path, _maximum):
                return model.canonical(action) if path.name == 'fault-result.json' else fixture_bytes
            def save(path, value, exclusive=False):
                self.assertTrue(exclusive)
                with path.open('x') as handle: handle.write(json.dumps(value))
                path.chmod(0o600)
                calls.append(('file', path.name, value['status']))
            def guard(_run):
                calls.append(('guard',))
                if fail_guard: raise RuntimeError('PRIVATE_TEST_SECRET')
            def query(_state, sql):
                self.assertTrue(sql.startswith('SELECT'))
                calls.append(('readonly-query',))
                return snapshot
            q = SimpleNamespace(CACHE=base, read_private_bytes=read, validate_fixture=lambda *_: None,
                state_path=lambda _: base / 'state.json', private_directory=lambda p: self.assertEqual(p.stat().st_mode & 0o777, 0o700),
                save_json=save, db_query=query)
            fault = SimpleNamespace(read_context=lambda _: (q, {}, {'bindingSha256': HASH}, base), admit_absent=guard)
            with patch.object(runtime, 'STATIC_DRAFT_ONLY', False), patch.object(runtime, 'verify_sources', return_value=HASH), \
                patch.object(runtime, 'fault_module', return_value=fault), patch.object(runtime.time, 'monotonic_ns', return_value=0):
                if fail_guard:
                    with self.assertRaisesRegex(model.ObservationRefused, 'OBSERVER_INCOMPLETE'):
                        runtime.observe('abcdef012345', 'absent-checkpoint', SCOPE)
                else:
                    result = runtime.observe('abcdef012345', 'absent-checkpoint', SCOPE)
                    self.assertEqual(result['status'], 'CATALOG_CHECKPOINT_RECORDED')
                    with self.assertRaisesRegex(model.ObservationRefused, 'NO_REPLAY'):
                        runtime.observe('abcdef012345', 'absent-checkpoint', SCOPE)
            proof = json.loads((base / 'm7c-interruption-observer-abcdef012345/absent-checkpoint.json').read_text())
            self.assertNotIn('PRIVATE_TEST_SECRET', json.dumps(proof))
            return calls, proof

    def test_runtime_guards_both_sides_of_one_read_and_owns_exclusive_evidence(self):
        calls, proof = self.runtime_mock()
        self.assertEqual(calls, [('file', 'absent-checkpoint-invocation.json', 'STARTED'), ('guard',),
            ('readonly-query',), ('guard',), ('file', 'absent-checkpoint.json', 'CATALOG_CHECKPOINT_RECORDED')])
        self.assertEqual(proof['recoveryAcceptance'], 'CATALOG_ONLY_BROWSER_AND_PHYSICAL_PENDING')

    def test_failed_admission_persists_incomplete_without_any_query_or_secret(self):
        calls, proof = self.runtime_mock(fail_guard=True)
        self.assertNotIn(('readonly-query',), calls)
        self.assertEqual(proof['status'], 'INCOMPLETE')
        self.assertNotIn('snapshot', proof)


if __name__ == '__main__':
    unittest.main()
