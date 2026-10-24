"""Offline guard/cleanup tests. All infrastructure and process operations are mocked."""
import contextlib
from datetime import datetime, timedelta, timezone
import os
import io
import json
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lifecycle as l
import m7c_restore_common as common

def setUpModule():
    """Create a hermetic owned cache below ROOT, retaining the real nofollow/private-path guards."""
    (common.ROOT / 'node_modules').mkdir(exist_ok=True)
    temporary = tempfile.TemporaryDirectory(dir=common.ROOT / 'node_modules', prefix='vectorix-s3-outage-guards-')
    unittest.addModuleCleanup(temporary.cleanup)
    cache = Path(temporary.name) / '.cache/vectorix'
    cache.mkdir(parents=True, mode=0o700)
    cache_patch = mock.patch.object(common, 'CACHE', cache)
    cache_patch.start()
    unittest.addModuleCleanup(cache_patch.stop)


RUN = '012345abcdef'


def state():
    return {'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'namespace': 'vectorix-m7c-s3-outage', 'runId': RUN, 'phase': 'READY', 'resources': {name: {} for name in l.SERVICES},
        'processes': {name: {'service': name, 'pid': index + 100} for index, name in enumerate(l.APPS)}}


class LifecycleTests(unittest.TestCase):
    def guarded(self, purpose, fault_phase='NOT_STARTED', rustfs=True, stopped=False, final=None):
        value = state()
        calls = []

        def owned(_state, service, running=None):
            calls.append((service, running))
            actual = rustfs if service == 'rustfs' else True
            l.require(actual is running, 'mock-exact-running-state')
            return {'State': {'Running': actual}}

        def identity(pid):
            return {'state': 'T' if stopped and pid == value['processes']['workers']['pid'] else 'S'}

        with contextlib.ExitStack() as stack:
            for name, replacement in [('pins', lambda *_: None), ('schema', lambda *_: None),
                    ('smtp_ready', lambda *_: None), ('fault_phase', lambda *_: fault_phase),
                    ('owned', owned), ('process_alive', lambda *_: True), ('process_identity', identity),
                    ('watchdog_admission', lambda *_: {'budgetSeconds': 900})]:
                stack.enter_context(mock.patch.object(l, name, replacement))
            if final is not None:
                stack.enter_context(mock.patch.object(l, 'read_private_bytes', return_value=json.dumps(final).encode()))
            return l.guard(value, purpose), calls

    def test_normal_guard_never_admits_stopped_storage(self):
        with self.assertRaisesRegex(l.GuardError, 'exact-running'):
            self.guarded('observe', rustfs=False)

    def test_normal_guard_never_admits_paused_worker(self):
        with self.assertRaisesRegex(l.GuardError, 'exact-process-run-state'):
            self.guarded('observe', stopped=True)

    def test_staged_guard_requires_only_the_exact_worker_paused(self):
        proof, calls = self.guarded('staged-observe', 'PAUSED', stopped=True)
        self.assertTrue(proof['resourceOwnership'])
        self.assertTrue(all(running is True for _, running in calls))
        with self.assertRaisesRegex(l.GuardError, 'exact-process-run-state'):
            self.guarded('staged-observe', 'PAUSED', stopped=False)

    def test_outage_guard_changes_only_rustfs_running_expectation(self):
        proof, calls = self.guarded('outage-observe', 'OUTAGE', rustfs=False)
        self.assertEqual(proof['purpose'], 'outage-observe')
        self.assertEqual(dict(calls), {name: name != 'rustfs' for name in l.SERVICES})
        with self.assertRaisesRegex(l.GuardError, 'outage-phase'):
            self.guarded('outage-observe', 'WATCHDOG_INTERVENED', rustfs=False)

    def test_successful_online_phase_requires_nonintervening_watchdog_final(self):
        final = {'schemaVersion': 1, 'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'runId': RUN, 'intervened': False,
            'storageRunning': True, 'sameWorkerResumed': True}
        self.guarded('observe', 'RESTORED', final=final)
        with self.assertRaisesRegex(l.GuardError, 'normal-stop-required'):
            self.guarded('observe', 'RESTORED', final={**final, 'intervened': True})

    def test_intervention_is_irreversible_even_with_later_restore_receipt(self):
        with tempfile.TemporaryDirectory(dir=common.CACHE) as temporary:
            directory = Path(temporary)
            for filename in ['fault-restore-receipt.json', 'watchdog-intervention.json']:
                l.save_json(directory / filename, {'schemaVersion': 1, 'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'runId': RUN}, exclusive=True)
            with mock.patch.object(l, 'state_path', return_value=directory / 'state.json'):
                self.assertEqual(l.fault_phase(state()), 'WATCHDOG_INTERVENED')

    def test_cleanup_resumes_owned_stopped_worker_before_graceful_termination(self):
        value = {'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'namespace': 'vectorix-m7c-s3-outage', 'runId': RUN, 'phase': 'READY', 'resources': {},
            'processes': {'workers': {'service': 'workers', 'pid': 123}}}
        signals = []
        alive = True
        stopped = True

        def send(_fd, code):
            nonlocal alive, stopped
            signals.append(code)
            if code == signal.SIGCONT:
                stopped = False
            elif code == signal.SIGTERM:
                alive = False

        with tempfile.TemporaryDirectory(dir=common.CACHE) as temporary, contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(l, 'state_path', return_value=Path(temporary) / 'state.json'))
            stack.enter_context(mock.patch.object(l, 'save'))
            stack.enter_context(mock.patch.object(l, 'process_alive', side_effect=lambda *_: alive))
            stack.enter_context(mock.patch.object(l, 'process_identity', side_effect=lambda *_: {'state': 'T' if stopped else 'S'}))
            stack.enter_context(mock.patch.object(l.os, 'pidfd_open', return_value=999))
            stack.enter_context(mock.patch.object(l.os, 'close'))
            stack.enter_context(mock.patch.object(l.signal, 'pidfd_send_signal', side_effect=send))
            operation = stack.enter_context(mock.patch.object(l, 'run'))
            l.cleanup(value)
            self.assertEqual(signals, [signal.SIGCONT, signal.SIGTERM])
            self.assertEqual(value['phase'], 'CLEANED_EVIDENCE_RETAINED')
            operation.assert_not_called()

    def test_control_process_recycled_pid_is_not_alive(self):
        saved = {'pid': 123, 'startTicks': 'old', 'bootId': 'boot'}
        with mock.patch.object(l.Path, 'read_text', return_value='boot'), \
                mock.patch.object(l, 'process_identity', return_value={'startTicks': 'new'}):
            self.assertFalse(l.control_alive(saved))

    def test_watchdog_admission_never_refreshes_an_expired_original_deadline(self):
        value = state()
        ack = {'schemaVersion': 1, 'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'runId': RUN, 'budgetSeconds': 900,
            'worker': value['processes']['workers'], 'rustfs': value['resources']['rustfs'],
            'control': {}, 'deadlineMonotonicNs': '1000'}
        with mock.patch.object(l, 'read_private_bytes', return_value=json.dumps(ack).encode()), \
                mock.patch.object(l, 'control_alive', return_value=True), \
                mock.patch.object(l.Path, 'exists', return_value=False), \
                mock.patch.object(l.time, 'monotonic_ns', return_value=1000):
            with self.assertRaisesRegex(l.GuardError, 'original-watchdog-required'):
                l.watchdog_admission(value)
        with mock.patch.object(l, 'read_private_bytes', return_value=json.dumps(ack).encode()), \
                mock.patch.object(l, 'control_alive', return_value=True), \
                mock.patch.object(l.Path, 'exists', return_value=False), \
                mock.patch.object(l.time, 'monotonic_ns', return_value=999):
            self.assertEqual(l.watchdog_admission(value)['deadlineMonotonicNs'], '1000')

    def test_entry_refuses_before_resource_access_in_either_gate_state(self):
        for disabled in [True, False]:
            with self.subTest(disabled=disabled), mock.patch.object(l, 'STATIC_DRAFT_ONLY', disabled), \
                    mock.patch.object(l, 'load', side_effect=AssertionError('must not read state')), \
                    mock.patch.object(l, 'run', side_effect=AssertionError('must not access resources')), \
                    mock.patch.object(sys, 'argv', ['lifecycle.py']), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises((l.GuardError, SystemExit)):
                    l.main()


class ProtocolTests(unittest.TestCase):
    def test_closed_scenario_paths_and_labels_do_not_overlap(self):
        first = l.state_path(RUN, 'INGESTION_V1')
        other = l.state_path(RUN, 'CLEANUP_V1')
        self.assertNotEqual(first, other)
        self.assertIn('vectorix-m7c-s3-cleanup-', str(other))
        self.assertEqual(l.labels({'runId': RUN, 'scenario': 'CLEANUP_V1'}, 'rustfs'),
            {'vectorix.m7c-s3-cleanup.run': RUN, 'vectorix.m7c-s3-cleanup.service': 'rustfs'})
        for scenario in [None, '', 'CLEANUP', '__proto__']:
            with self.assertRaises(l.GuardError):
                l.state_path(RUN, scenario)

    def test_old_and_cross_scenario_receipts_cannot_be_adopted(self):
        value = state()
        current = l.receipt_scope(value)
        self.assertTrue(l.receipt_matches(value, current))
        for invalid in [{'schemaVersion': 1, 'runId': RUN}, {**current, 'scenario': 'CLEANUP_V1'},
                {**current, 'protocolVersion': 1}, {**current, 'runId': '000000000000'}]:
            self.assertFalse(l.receipt_matches(value, invalid))

    def test_old_and_cross_scenario_states_fail_before_environment_or_resource_checks(self):
        with mock.patch.object(l, 'environment', side_effect=AssertionError('no environment resolution')):
            for scenario in ['INGESTION_V1', 'CLEANUP_V1']:
                with self.assertRaisesRegex(l.GuardError, 'state-identity'):
                    l.validate({'schemaVersion': 1, 'runId': RUN}, RUN, scenario)
                with self.assertRaisesRegex(l.GuardError, 'state-identity'):
                    l.validate({**l.receipt_scope(state()), 'namespace': 'vectorix-m7c-s3-outage'}, RUN, 'CLEANUP_V1')


class VectorLifecycleTests(unittest.TestCase):
    def test_vector_namespace_roles_and_fault_target_are_closed(self):
        value = {'scenario': 'VECTOR_PROVISION_V1'}
        self.assertEqual(l.fault_store(value), 'vector')
        self.assertEqual(l.app_roles(value), (*l.APPS, 'embedding'))
        self.assertNotEqual(l.state_path(RUN, value['scenario']), l.state_path(RUN, 'CLEANUP_V1'))
        self.assertEqual(l.scenario_spec(value['scenario'])['namespace'], 'vectorix-m7c-vector-provision')

    def test_vector_outage_guard_refuses_any_other_store_or_worker_change(self):
        value = state()
        value.update(scenario='VECTOR_PROVISION_V1', namespace='vectorix-m7c-vector-provision')
        value['processes']['embedding'] = {'pid': 999, 'service': 'embedding'}
        calls = []
        def owned(_value, service, running=None):
            calls.append((service, running))
        with contextlib.ExitStack() as stack:
            for name, replacement in [('pins', lambda *_: None), ('schema', lambda *_: None), ('smtp_ready', lambda *_: None), ('owned', owned), ('fault_phase', lambda *_: 'OUTAGE'), ('watchdog_admission', lambda *_: None), ('process_alive', lambda *_: True), ('process_identity', lambda *_: {'state': 'S'})]:
                stack.enter_context(mock.patch.object(l, name, replacement))
            self.assertTrue(l.guard(value, 'outage-observe')['resourceOwnership'])
        self.assertEqual(dict(calls), {name: name != 'vector' for name in l.SERVICES})

    def test_synthetic_fixture_environment_contains_no_database_or_smtp_secrets(self):
        value = {'scenario': 'VECTOR_PROVISION_V1', 'runId': RUN, 'environment': {'DATABASE_URL': 'must-not-forward', 'ENCRYPTION_SECRET': 'must-not-forward'}}
        result = l.app_environment(value, 'embedding')
        self.assertEqual(set(result), {'NODE_ENV', 'TZ', 'VECTORIX_M7C_S3_OUTAGE_RUN', 'VECTORIX_M7C_S3_OUTAGE_ROLE', 'VECTORIX_M7C_S3_SCENARIO'})
        self.assertNotIn('must-not-forward', str(result))


class PrimedVectorObserverTests(unittest.TestCase):
    def bundle(self):
        value = state()
        value.update(scenario='VECTOR_PROVISION_V1', namespace='vectorix-m7c-vector-provision', commit='c' * 40)
        value['resources']['vector'] = {'id': 'v' * 64}
        value['processes']['workers'] = {'pid': 123, 'startTicks': '42'}
        value['inputs'] = {'helpers': {'vector-observe.mjs': 'a' * 64, 'vector-snapshot.mjs': 'b' * 64}}
        control = {'pid': 456, 'startTicks': '43', 'bootId': '0' * 8 + '-' + '0' * 4 + '-' + '0' * 4 + '-' + '0' * 4 + '-' + '0' * 12, 'cwd': str(l.ROOT), 'commandSha256': 'd' * 64}
        scope = l.receipt_scope(value)
        staged = {**scope, 'phase': 'vector-g2-staged', 'status': 'OBSERVED', 'faultAdmission': {'taskId': 'task'}}
        watchdog = {**scope, 'control': {'pid': 789}, 'deadlineMonotonicNs': '1900000000000'}
        encode = lambda item: json.dumps(item).encode()
        intent = {**scope, 'namespace': value['namespace'], 'phase': 'vector-outage-failed', 'status': 'ONE_SHOT_READ_ONLY', 'control': control, 'sourceCommit': value['commit'], 'helperPinsSha256': l.digest(l.canonical(value['inputs']['helpers'])), 'stagedProofSha256': l.digest(encode(staged)), 'watchdogAckSha256': l.digest(encode(watchdog)), 'deadlineMonotonicNs': watchdog['deadlineMonotonicNs'], 'workerPid': 123, 'workerStartTicks': '42', 'vectorContainerId': value['resources']['vector']['id']}
        ready = {**intent, 'status': 'ARMED', 'intentSha256': l.digest(encode(intent)), 'armedAt': (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), 'armedMonotonicNs': '999000000000'}
        records = {'observe-vector-g2-staged.json': staged, 'watchdog-ack.json': watchdog, 'observe-vector-outage-failed-intent.json': intent, 'vector-observer-ready.json': ready}
        actual = {'state': 'S', 'command': [b'node', b'tests/acceptance/s3-outage/vector-observe.mjs', b'--run', RUN.encode(), b'--scenario', b'VECTOR_PROVISION_V1', b'--phase', b'vector-outage-failed', b'']}
        return value, records, actual

    def admission(self, value, records, actual, *, live=True, fresh=True, alive=True):
        with mock.patch.object(l, 'read_private_bytes', side_effect=lambda path, _bound: json.dumps(records[path.name]).encode()), mock.patch.object(l, 'control_alive', return_value=alive), mock.patch.object(l, 'process_identity', return_value=actual), mock.patch.object(l.time, 'monotonic_ns', return_value=1000000000000):
            return l.vector_observer_admission(value, ready=True, fresh=fresh, live=live)

    def test_ready_ack_requires_exact_scope_sources_intent_staged_and_original_watchdog(self):
        value, records, actual = self.bundle()
        self.assertEqual(self.admission(value, records, actual)['control']['pid'], 456)
        for field in ['sourceCommit', 'helperPinsSha256', 'stagedProofSha256', 'watchdogAckSha256', 'deadlineMonotonicNs', 'intentSha256', 'workerStartTicks', 'vectorContainerId', 'phase']:
            changed = json.loads(json.dumps(records))
            changed['vector-observer-ready.json'][field] = 'changed'
            with self.subTest(field=field), self.assertRaises(l.GuardError):
                self.admission(value, changed, actual)
        for name in ['watchdog-ack.json', 'observe-vector-g2-staged.json', 'observe-vector-outage-failed-intent.json']:
            changed = json.loads(json.dumps(records)); changed[name]['unexpected'] = True
            with self.subTest(reference=name), self.assertRaises(l.GuardError):
                self.admission(value, changed, actual)

    def test_observer_identity_and_freshness_are_checked_at_consumption_not_extended_into_trace(self):
        value, records, actual = self.bundle()
        for process_state in ['T', 't', 'Z', 'X', 'x']:
            with self.subTest(state=process_state), self.assertRaisesRegex(l.GuardError, 'command-state'):
                self.admission(value, records, {**actual, 'state': process_state})
        with self.assertRaisesRegex(l.GuardError, 'not-live'):
            self.admission(value, records, actual, alive=False)
        with self.assertRaisesRegex(l.GuardError, 'command-state'):
            self.admission(value, records, {**actual, 'command': [b'wrong']})
        records['vector-observer-ready.json']['armedAt'] = (datetime.now(timezone.utc) - timedelta(seconds=91)).isoformat()
        records['vector-observer-ready.json']['armedMonotonicNs'] = '909000000000'
        with self.assertRaisesRegex(l.GuardError, 'ready-stale'):
            self.admission(value, records, actual)
        self.assertEqual(self.admission(value, records, actual, fresh=False)['ready']['status'], 'ARMED')

    def test_exact_fault_intent_is_required_for_each_transition_pair(self):
        value, records, _actual = self.bundle()
        scope = l.receipt_scope(value)
        with tempfile.TemporaryDirectory(dir=common.CACHE) as temporary:
            directory = Path(temporary)
            staged_raw = json.dumps(records['observe-vector-g2-staged.json']).encode()
            reader = lambda path, _bound: staged_raw if path.name == 'observe-vector-g2-staged.json' else (directory / path.name).read_bytes()
            admission = {'readySha256': 'a' * 64, 'ready': {'armedMonotonicNs': '999000000000'}}
            with mock.patch.object(l, 'state_path', return_value=directory / 'state.json'), mock.patch.object(l, 'fault_phase', return_value='PAUSED'), mock.patch.object(l, 'read_private_bytes', side_effect=reader), mock.patch.object(l, 'vector_observer_admission', return_value=admission), mock.patch.object(l.time, 'monotonic_ns', return_value=1000000000000):
                self.assertEqual(l.vector_observer_transition(value, True, True, 'PAUSED'), 'UP_PAUSED')
                for pair in [(False, True), (False, False), (True, False)]:
                    with self.assertRaises(l.GuardError): l.vector_observer_transition(value, *pair, 'PAUSED')
                intent = {**scope, 'stagedProofSha256': l.digest(staged_raw), 'observerReadySha256': 'a' * 64, 'vector': value['resources']['vector'], 'staged': records['observe-vector-g2-staged.json']['faultAdmission']}
                (directory / 'fault-storage-outage-intent.json').write_text(json.dumps(intent))
                for pair, expected in [((True, True), 'UP_PAUSED'), ((False, True), 'DOWN_PAUSED'), ((False, False), 'DOWN_RUNNING')]: self.assertEqual(l.vector_observer_transition(value, *pair, 'PAUSED'), expected)
                with self.assertRaisesRegex(l.GuardError, 'invalid-pair'): l.vector_observer_transition(value, True, False, 'PAUSED')
                # The final receipt can arrive after a PAUSED phase/worker sample. It must not reinterpret that sample as OUTAGE.
                receipt = {**scope, 'observerReadySha256': 'a' * 64, 'stagedProofSha256': l.digest(staged_raw), 'storageStopped': True, 'sameWorkerResumed': True}
                (directory / 'fault-storage-outage-receipt.json').write_text(json.dumps(receipt))
                self.assertEqual(l.vector_observer_transition(value, False, True, 'PAUSED'), 'DOWN_PAUSED')
                self.assertEqual(l.vector_observer_transition(value, False, False, 'OUTAGE'), 'DOWN_RUNNING')
                with self.assertRaisesRegex(l.GuardError, 'outage-pair'): l.vector_observer_transition(value, False, True, 'OUTAGE')
                intent['observerReadySha256'] = 'b' * 64
                (directory / 'fault-storage-outage-intent.json').write_text(json.dumps(intent))
                with self.assertRaisesRegex(l.GuardError, 'transition-intent'): l.vector_observer_transition(value, False, False, 'PAUSED')

    def test_cleanup_drains_exact_observer_before_touching_saved_stores(self):
        value, _records, _actual = self.bundle()
        value['processes'] = {}
        value['resources'] = {'vector': {'id': 'saved', 'name': 'owned-name', 'volume': 'owned-volume'}}
        events = []
        with tempfile.TemporaryDirectory(dir=common.CACHE) as temporary:
            directory = Path(temporary); (directory / 'observe-vector-outage-failed-intent.json').touch()
            with mock.patch.object(l, 'state_path', return_value=directory / 'state.json'), mock.patch.object(l, 'save'), mock.patch.object(l, 'vector_observer_admission', return_value={'control': {'pid': 456}}), mock.patch.object(l, 'control_alive', side_effect=[True, True, False]), mock.patch.object(l, 'process_identity', return_value={'state': 'S'}), mock.patch.object(l.os, 'pidfd_open', return_value=999), mock.patch.object(l.os, 'close'), mock.patch.object(l.signal, 'pidfd_send_signal', side_effect=lambda *_args: events.append('TERM_OBSERVER')), mock.patch.object(l, 'owned', return_value={'State': {'Running': False}}), mock.patch.object(l, 'owned_volume'), mock.patch.object(l, 'run', side_effect=lambda *_args, **_kwargs: events.append('STORE') or b''):
                l.cleanup(value)
        self.assertEqual(events[0], 'TERM_OBSERVER')
        self.assertIn('STORE', events)
        self.assertEqual(value['phase'], 'CLEANED_EVIDENCE_RETAINED')


class PrimedVectorGuardWiringTests(unittest.TestCase):
    def test_guard_samples_worker_before_final_storage_state_and_returns_closed_transition(self):
        value = state(); value.update(scenario='VECTOR_PROVISION_V1', namespace='vectorix-m7c-vector-provision')
        value['processes']['embedding'] = {'pid': 999, 'service': 'embedding'}
        vector_reads = 0
        def owned(_state, service, running=None):
            nonlocal vector_reads
            if service == 'vector':
                vector_reads += 1
                return {'State': {'Running': vector_reads == 1}}
            l.require(running is True, 'other-store-must-stay-online')
            return {'State': {'Running': True}}
        with contextlib.ExitStack() as stack:
            for name, replacement in [('pins', lambda *_: None), ('schema', lambda *_: None), ('smtp_ready', lambda *_: None), ('owned', owned), ('fault_phase', lambda *_: 'PAUSED'), ('watchdog_admission', lambda *_: None), ('process_alive', lambda *_: True), ('process_identity', lambda *_: {'state': 'S'})]: stack.enter_context(mock.patch.object(l, name, replacement))
            transition = stack.enter_context(mock.patch.object(l, 'vector_observer_transition', return_value='DOWN_RUNNING'))
            proof = l.guard(value, 'vector-outage-watch')
            transition.assert_called_once_with(value, False, False, 'PAUSED')
            self.assertEqual(proof['vectorTransition'], 'DOWN_RUNNING')
            self.assertEqual(vector_reads, 2)
        value['scenario'] = 'INGESTION_V1'
        with mock.patch.object(l, 'pins'), mock.patch.object(l, 'fault_phase', return_value='PAUSED'), mock.patch.object(l, 'owned') as inspect:
            with self.assertRaisesRegex(l.GuardError, 'observer-scenario'): l.guard(value, 'vector-outage-watch')
            inspect.assert_not_called()

    def test_observer_cleanup_timeout_prevents_any_store_mutation(self):
        value = {'scenario': 'VECTOR_PROVISION_V1', 'protocolVersion': 2, 'runId': RUN, 'resources': {}, 'processes': {}, 'phase': 'READY'}
        with tempfile.TemporaryDirectory(dir=common.CACHE) as temporary:
            directory = Path(temporary); (directory / 'observe-vector-outage-failed-intent.json').touch()
            with mock.patch.object(l, 'state_path', return_value=directory / 'state.json'), mock.patch.object(l, 'save'), mock.patch.object(l, 'vector_observer_admission', return_value={'control': {'pid': 456}}), mock.patch.object(l, 'control_alive', return_value=True), mock.patch.object(l, 'process_identity', return_value={'state': 'S'}), mock.patch.object(l.os, 'pidfd_open', return_value=999), mock.patch.object(l.os, 'close'), mock.patch.object(l.signal, 'pidfd_send_signal'), mock.patch.object(l.time, 'monotonic', side_effect=[0, 56]), mock.patch.object(l, 'run') as mutate:
                with self.assertRaisesRegex(l.GuardError, 'observer-graceful-stop-timeout'): l.cleanup(value)
                mutate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
