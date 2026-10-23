"""OFFLINE tests to run only after the capacity measurement: no real process/Docker/DB/provider action."""
from __future__ import annotations

from contextlib import nullcontext
import copy
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr, redirect_stdout

import fault_admission as admission
import fault_driver as driver

RUN = 'abcdef012345'


def write_json(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


def state_fixture():
    state = {key: {} for key in ['migrations', 'acceptanceSources', 'builds', 'images',
        'resourceLimits', 'resources', 'modelVolume']}
    state.update(namespace=admission.NAMESPACE, runId=RUN, prefix=admission.NAMESPACE + '-' + RUN,
        applicationDatabase='isolated_app_test', vectorDatabase='isolated_vector_test', commit='a' * 40,
        lockfileSha256='b' * 64, prismaConfigSha256='c' * 64, apiOrigin='http://127.0.0.1:45100',
        webOrigin='http://127.0.0.1:45101', phase='READY_FOR_QUALITY_IMPORT', collectorProcess=None,
        processes={'api': {'service': 'api'}, 'workers': {'service': 'workers', 'pid': 987654}},
        dashboardProcesses={})
    state['resources'] = {'ollama': {'id': 'd' * 64}}
    return state


def enrollment_fixture(state):
    return {'schemaVersion': 1, 'kind': 'FRESH_BOUNDARY_FAULT', 'runId': RUN,
        'namespace': admission.NAMESPACE, 'enrolledAt': 1, 'bindingSha256': admission.binding(state),
        'sources': {'fixture': 'a' * 64}, 'scope': 'ONE_DOCUMENT_ONE_COLLECTION_SEMANTIC_REBUILD',
        'enrollmentEmptyContentObserved': True}


def row_fixture():
    return {'taskId': 'task-1', 'taskStatus': 'PROCESSING', 'stage': 'SEMANTIC_PLANNING',
        'claimLive': True, 'leaseEpoch': '2', 'indexedDocumentId': 'candidate-1',
        'completedUnits': 32, 'boundaryScores': [10] * 31,
        'sourceHash': '1' * 64, 'profileHash': '2' * 64, 'unitManifestHash': '3' * 64,
        'modelIdentity': '4' * 64, 'sourceVersionId': 'version-1', 'extractionId': 'extraction-1',
        'extractorVersion': 'utf8-text-v1', 'buildRevision': 1, 'metadataRevision': 1,
        'inFlight': [{'id': 'work-1', 'state': 'IN_FLIGHT', 'taskId': 'task-1',
            'leaseEpoch': '2', 'dispatchStartedAt': '2026-10-23T12:00:00Z', 'deadlineLive': True}]}


class AdmissionTests(unittest.TestCase):
    def test_disabled_entries_refuse_before_import_or_state(self):
        with patch.object(driver, 'STATIC_DRAFT_ONLY', True), patch.object(admission, 'quality_module') as load:
            with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_DISABLED'):
                driver.main([])
            load.assert_not_called()
        with patch.object(admission, 'STATIC_DRAFT_ONLY', True):
            with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_DISABLED'):
                admission.quality_module()

    def test_enrollment_binds_static_sources_but_not_later_worker_record(self):
        state = state_fixture()
        enrollment = enrollment_fixture(state)
        with patch.object(admission, 'fault_sources', return_value=enrollment['sources']):
            admission.validate_enrollment(state, enrollment)
            state['processes']['workers']['pid'] += 1
            admission.validate_enrollment(state, enrollment)
            state['resources']['ollama']['id'] = 'e' * 64
            with self.assertRaises(admission.FaultRefused):
                admission.validate_enrollment(state, enrollment)

    def test_absence_is_exact_original_worker_and_does_not_relax_existing_guard(self):
        state = state_fixture()
        enrollment = enrollment_fixture(state)
        old_worker = copy.deepcopy(state['processes']['workers'])
        calls = []
        q = SimpleNamespace(
            validate_state=lambda *_args, **_kwargs: calls.append('validate'),
            verify_pins=lambda *_args: calls.append('pins'), SERVICES=['postgres', 'ollama'],
            owned=lambda *_args, **_kwargs: {'State': {'Paused': False}},
            verify_schema=lambda *_args: calls.append('schema'),
            process_alive=lambda _state, record: record['service'] == 'api',
            read_private_bytes=lambda *_args: b'{}', state_path=lambda *_args: Path('/synthetic/state.json'),
            validate_fixture=lambda *_args: None,
            guard=lambda *_args: self.fail('existing quality.guard must not be changed or bypass-mutated'))
        with patch.object(admission, 'fault_sources', return_value=enrollment['sources']):
            proof = admission.admission(q, state, enrollment, old_worker, absent=True)
            self.assertTrue(proof['workerAbsent'])
            self.assertEqual(proof['contentAuthorization'], 'NORMAL_SESSION_REQUIRED')
            self.assertIn('pins', calls)
            with self.assertRaises(admission.FaultRefused):
                admission.admission(q, state, enrollment, {'service': 'workers', 'pid': 999999}, absent=True)
            state['phase'] = 'QUALITY_CAPTURE_COMPLETE'
            with self.assertRaises(admission.FaultRefused):
                admission.admission(q, state, enrollment, old_worker, absent=True)

    def test_live_worker_or_paused_dependency_cannot_masquerade_as_absence(self):
        state = state_fixture()
        enrollment = enrollment_fixture(state)
        q = SimpleNamespace(validate_state=lambda *_args, **_kwargs: None, verify_pins=lambda *_args: None,
            SERVICES=['ollama'], owned=lambda *_args, **_kwargs: {'State': {'Paused': False}},
            verify_schema=lambda *_args: None, process_alive=lambda *_args: True)
        with patch.object(admission, 'fault_sources', return_value=enrollment['sources']):
            with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_WORKER_ABSENCE'):
                admission.admission(q, state, enrollment, state['processes']['workers'], absent=True)
            q.owned = lambda *_args, **_kwargs: {'State': {'Paused': True}}
            with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_NO_PAUSED_DEPENDENCY'):
                admission.admission(q, state, enrollment, state['processes']['workers'], absent=True)

    def test_enabled_invalid_arguments_are_finite_and_never_reach_a_runtime(self):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(driver, 'STATIC_DRAFT_ONLY', False), patch.object(driver, 'read_context') as read, \
            redirect_stdout(output), redirect_stderr(errors):
            with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_ARGUMENTS'):
                driver.main(['--run', 'PRIVATE_SECRET', '--mode', 'PRIVATE_SECRET'])
            read.assert_not_called()
        self.assertEqual(output.getvalue() + errors.getvalue(), '')
        self.assertEqual(driver.safe_diagnostic(RuntimeError('PRIVATE_SECRET')), 'FAULT_ACTION_INCOMPLETE')

    def test_enrollment_is_before_all_content_and_one_shot(self):
        with tempfile.TemporaryDirectory() as temporary:
            state, counts, calls = state_fixture(), {'documents': 0, 'collections': 0}, []
            q = SimpleNamespace(CACHE=Path(temporary), state_lock=nullcontext, read_state=lambda *_: state,
                state_path=lambda *_: Path('/synthetic/state.json'), guard=lambda *_: calls.append('original-guard'),
                db_query=lambda *_: counts, private_directory=lambda *_: None, save_json=write_json)
            with patch.object(admission, 'quality_module', return_value=q), \
                patch.object(admission, 'fault_sources', return_value={'fixture': 'a' * 64}):
                counts['documents'] = 1
                with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_ENROLL_BEFORE_CONTENT'):
                    admission.enroll(RUN)
                self.assertFalse((Path(temporary) / ('m7c-interruption-' + RUN)).exists())
                counts['documents'] = 0
                result = admission.enroll(RUN)
                self.assertEqual(result['faultScenarioAcceptance'], 'NOT_RUN')
                with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_ENROLLMENT_EXISTS'):
                    admission.enroll(RUN)
            self.assertEqual(calls, ['original-guard'] * 3)


class WaitingTests(unittest.TestCase):
    def test_fixed_boundary_query_is_owner_scoped_and_discards_the_raw_checkpoint(self):
        state = state_fixture()
        scope = {'organizationId': 'org-owner', 'collectionId': 'collection-1',
            'generationId': 'generation-b', 'documentId': 'document-1'}
        row = row_fixture()
        row.update(activeStatus='ACTIVE', generationStatus='BUILDING', previousGenerationId='generation-a',
            activeGenerationId='generation-a', generationId='generation-b', chunkerVersion='semantic-utf8-v1',
            provider='OLLAMA', dimensions='128', unitCount=75, planState='PLANNING',
            checkpointHex='0000803f' * 128)
        queries = []
        def query(_state, sql):
            queries.append(sql)
            return {'documents': 1, 'collections': 1, 'rows': [copy.deepcopy(row)],
                'databaseNow': '2026-10-23T12:00:00Z'}
        q = SimpleNamespace(read_private_bytes=lambda *_: json.dumps({'users': {'owner':
            {'organizationId': 'org-owner'}}}).encode(), validate_fixture=lambda *_: None,
            state_path=lambda *_: Path('/synthetic/state.json'), db_query=query)
        observed = admission.observe_boundary(q, state, scope)
        self.assertNotIn('checkpointHex', observed)
        self.assertEqual(len(observed['lastVectorSha256']), 64)
        self.assertIn("c.\"organizationId\"='org-owner'", queries[0])
        self.assertTrue(queries[0].lstrip().startswith('SELECT'))
        with self.assertRaises(admission.FaultRefused):
            admission.observe_boundary(q, state, {**scope, 'collectionId': "bad' OR true"})
        self.assertEqual(len(queries), 1)
        row['provider'] = 'OPENAI'
        with self.assertRaises(admission.FaultRefused): admission.observe_boundary(q, state, scope)

    def test_matching_live_dispatch_is_required_and_clock_is_not_rewritten(self):
        clock, calls = [0], []
        stale = row_fixture()
        stale['inFlight'][0]['leaseEpoch'] = '1'
        rows = iter([stale, row_fixture()])
        def sleep(seconds):
            calls.append(seconds)
            clock[0] += int(seconds * 1_000_000_000)
        result = driver.wait_for_boundary(observe=lambda: next(rows), deadline=1_000_000_000,
            now=lambda: clock[0], sleep=sleep)
        self.assertEqual(result['leaseEpoch'], '2')
        self.assertEqual(calls, [0.1])

    def test_expired_work_or_claim_is_a_missed_checkpoint(self):
        for field in ['claimLive', 'deadlineLive']:
            clock = [0]
            row = row_fixture()
            if field == 'claimLive': row[field] = False
            else: row['inFlight'][0][field] = False
            def sleep(seconds): clock[0] += int(seconds * 1_000_000_000)
            with self.assertRaisesRegex(admission.FaultRefused, 'FAULT_IN_FLIGHT_CHECKPOINT_MISSED'):
                driver.wait_for_boundary(observe=lambda: row, deadline=200_000_000,
                    now=lambda: clock[0], sleep=sleep)


class DriverCompositionTests(unittest.TestCase):
    def execute_mock(self, *, pause_error=False, signal_error=False, changed_candidate=False):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            state = state_fixture()
            enrollment = enrollment_fixture(state)
            paused, alive, calls = [False], [True], []
            def save(path, value): write_json(path, value)
            def command(arguments, **_kwargs):
                self.assertEqual(arguments[0], 'docker')
                self.assertEqual(arguments[2], state['resources']['ollama']['id'])
                calls.append(arguments[1])
                paused[0] = arguments[1] == 'pause'
                if arguments[1] == 'pause' and pause_error: raise RuntimeError('PRIVATE_DOCKER_ERROR')
                return b''
            q = SimpleNamespace(state_lock=nullcontext, read_state=lambda *_args: state,
                owned=lambda *_args, **_kwargs: {'Id': state['resources']['ollama']['id'],
                    'State': {'Paused': paused[0]}},
                save_json=save, read_private_bytes=lambda path, _maximum: path.read_bytes(),
                base_environment=lambda: {}, run=command,
                process_alive=lambda *_args: alive[0])
            class Child:
                def __init__(self, *arguments, **kwargs):
                    self.arguments, self.kwargs = arguments, kwargs
                    control = json.loads((directory / 'fault-control.json').read_text())
                    save(directory / 'watchdog-ready.json', {'runId': RUN, 'parent': control['parent'],
                        'pauseDeadlineMonotonicNs': control['pauseDeadlineMonotonicNs'], 'ready': True})
                def poll(self): return None
                def wait(self, timeout):
                    calls.append('watchdog-wait')
                    return 0
            def kill(descriptor, signum):
                calls.append('SIGKILL')
                self.assertEqual((descriptor, signum), (12345, driver.signal.SIGKILL))
                if signal_error: raise RuntimeError('PRIVATE_SIGNAL_ERROR')
                alive[0] = False
            rows = [row_fixture(), row_fixture()]
            if changed_candidate: rows[1]['sourceHash'] = '9' * 64
            with patch.object(driver, 'STATIC_DRAFT_ONLY', False), \
                patch.object(driver, 'read_context', return_value=(q, state, enrollment, directory)), \
                patch.object(driver, 'admission', return_value={}), \
                patch.object(driver, 'exact_parent', return_value={'pid': 123, 'startTicks': '1',
                    'bootId': '12345678-1234-1234-1234-123456789abc', 'entrySha256': 'a' * 64, 'runId': RUN}), \
                patch.object(driver, 'observe_boundary', side_effect=rows), \
                patch.object(driver.subprocess, 'Popen', Child), \
                patch.object(driver.os, 'pidfd_open', return_value=12345, create=True), \
                patch.object(driver.os, 'close') as close, \
                patch.object(driver.signal, 'pidfd_send_signal', side_effect=kill, create=True), \
                patch.dict(os.environ, {'VECTORIX_FAULT_RUN': RUN, 'VECTORIX_FAULT_ROLE': 'driver'}):
                if pause_error or signal_error or changed_candidate:
                    with self.assertRaises(admission.FaultRefused): driver.crash(RUN, {})
                else:
                    result = driver.crash(RUN, {})
                    self.assertEqual(result['recoveryAcceptance'], 'NOT_OBSERVED')
                if not pause_error and not changed_candidate: close.assert_called_once_with(12345)
            self.assertFalse(paused[0])
            proof = json.loads((directory / 'fault-result.json').read_text())
            self.assertNotIn('PRIVATE_', json.dumps(proof))
            self.assertEqual(proof['recoveryAcceptance'], 'NOT_OBSERVED')
            self.assertEqual(proof['trialDeadlineAtEpochMs'] - proof['trialStartedAtEpochMs'], 900000)
            self.assertEqual(proof['status'], 'INCOMPLETE' if pause_error or signal_error or changed_candidate
                else 'WORKER_KILLED_MODEL_RESUMED')
            return calls

    def test_actual_mutations_are_only_exact_pause_pidfd_signal_and_finally_unpause(self):
        calls = self.execute_mock()
        self.assertEqual(calls, ['pause', 'SIGKILL', 'unpause', 'watchdog-wait'])

    def test_ambiguous_pause_and_failed_signal_still_run_finally_unpause(self):
        self.assertEqual(self.execute_mock(pause_error=True), ['pause', 'unpause', 'watchdog-wait'])
        self.assertEqual(self.execute_mock(signal_error=True), ['pause', 'SIGKILL', 'unpause', 'watchdog-wait'])

    def test_candidate_drift_never_sends_a_signal(self):
        self.assertNotIn('SIGKILL', self.execute_mock(changed_candidate=True))


class WatchdogTests(unittest.TestCase):
    def execute_mock(self, *, stale_armed=False):
        with tempfile.TemporaryDirectory() as temporary:
            directory, state = Path(temporary), state_fixture()
            parent = {'pid': 123, 'startTicks': '1', 'bootId': '12345678-1234-1234-1234-123456789abc',
                'entrySha256': 'a' * 64, 'runId': RUN}
            control = {'schemaVersion': 1, 'runId': RUN, 'bindingSha256': admission.binding(state),
                'status': 'WATCHDOG_ARMED' if stale_armed else 'PAUSE_REQUESTED', 'parent': parent,
                'modelId': state['resources']['ollama']['id'], 'pauseDeadlineMonotonicNs': driver.PAUSE_LIMIT_NS,
                'trialStartedAtEpochMs': 1700000000000, 'trialDeadlineAtEpochMs': 1700000900000,
                'trialDeadlineMonotonicNs': driver.TRIAL_LIMIT_NS}
            write_json(directory / 'fault-control.json', control)
            paused, calls = [True], []
            def command(arguments, **_kwargs):
                self.assertEqual(arguments, ['docker', 'unpause', state['resources']['ollama']['id']])
                calls.append('unpause')
                paused[0] = False
            q = SimpleNamespace(read_private_bytes=lambda path, _: path.read_bytes(), save_json=write_json,
                owned=lambda *_args, **_kwargs: {'Id': state['resources']['ollama']['id'], 'State': {'Paused': paused[0]}},
                run=command)
            with patch.object(driver, 'STATIC_DRAFT_ONLY', False), \
                patch.object(driver, 'read_context', return_value=(q, state, {}, directory)), \
                patch.object(driver, 'parent_alive', side_effect=[True, False]), \
                patch.object(driver.os, 'getppid', return_value=123), \
                patch.object(driver.time, 'monotonic_ns', return_value=0), \
                patch.dict(os.environ, {'VECTORIX_FAULT_RUN': RUN, 'VECTORIX_FAULT_ROLE': 'watchdog'}):
                driver.watchdog(RUN)
            self.assertFalse(paused[0])
            self.assertEqual(calls, ['unpause'])
            self.assertTrue(json.loads((directory / 'watchdog-recovery.json').read_text())['modelResumed'])

    def test_orphan_watchdog_unpauses_exact_model_even_with_stale_armed_read(self):
        # The parent can write PAUSE_REQUESTED/pause after the watchdog read ARMED,
        # then die before parent_alive returns. Cleanup must not depend on that stale status.
        self.execute_mock(stale_armed=True)

    def test_orphan_watchdog_resumes_a_matching_dispatched_pause(self):
        self.execute_mock()


if __name__ == '__main__':
    unittest.main()
