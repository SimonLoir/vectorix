"""Offline guard/cleanup tests. All infrastructure and process operations are mocked."""
import contextlib
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


if __name__ == '__main__':
    unittest.main()
