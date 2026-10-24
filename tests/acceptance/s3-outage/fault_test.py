"""Offline safety-control and evidence tests; no real signal, Docker, SQL or HTTP."""
import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fault as f
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
SHA1, SHA2 = '1' * 64, '2' * 64


def state():
    return {'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'namespace': 'vectorix-m7c-s3-outage', 'runId': RUN, 'phase': 'READY', 'processes': {'workers': {'pid': 123, 'startTicks': '42'}},
        'resources': {'rustfs': {'id': 'a' * 64}},
        'inputs': {'textFixtures': {'s3-outage-v1.txt': {'sha256': SHA1}, 's3-outage-v2.txt': {'sha256': SHA2}}}}


def staged():
    return {'schemaVersion': 1, 'kind': 'STAGED_ORIGINAL_CONFIRMED', 'organizationId': 'org-owned',
        'documentId': 'doc-owned', 'versionId': 'version-two', 'version': 2, 'originalSha256': SHA2,
        'observedAt': datetime.now(timezone.utc).isoformat(), 'workerPid': 123, 'workerStartTicks': '42',
        'rustfsContainerId': 'a' * 64, 'stored': True, 'ingestionStatus': 'PENDING', 'attempts': 0,
        'extractionPresent': False}


class FaultTests(unittest.TestCase):
    def test_original_monotonic_deadline_and_stop_requests(self):
        self.assertIsNone(f.watchdog_reason(899, 900, False, False))
        self.assertEqual(f.watchdog_reason(900, 900, False, False), 'ORIGINAL_DEADLINE_EXPIRED')
        self.assertEqual(f.watchdog_reason(1, 900, True, False), 'CONTROL_TERMINATED')
        self.assertEqual(f.watchdog_reason(1, 900, False, True), 'CLEANUP_REQUESTED')

    def test_signal_rechecks_identity_after_opening_pidfd(self):
        with mock.patch.object(f.l, 'process_alive', side_effect=[True, False]), \
                mock.patch.object(f.os, 'pidfd_open', return_value=999), \
                mock.patch.object(f.os, 'close') as close, \
                mock.patch.object(f.signal, 'pidfd_send_signal') as send:
            with self.assertRaisesRegex(f.l.GuardError, 'identity-required'):
                f.worker_signal(state(), signal.SIGSTOP)
            send.assert_not_called()
            close.assert_called_once_with(999)

    def test_recycled_worker_refuses_before_pidfd_or_signal(self):
        with mock.patch.object(f.l, 'process_alive', return_value=False), \
                mock.patch.object(f.os, 'pidfd_open') as opened:
            with self.assertRaisesRegex(f.l.GuardError, 'identity-required'):
                f.worker_signal(state(), signal.SIGCONT)
            opened.assert_not_called()

    def test_store_start_failure_does_not_strand_stopped_worker(self):
        with mock.patch.object(f.l, 'owned', side_effect=f.l.GuardError('mock-store-unavailable')), \
                mock.patch.object(f.l, 'process_alive', return_value=True), \
                mock.patch.object(f.l, 'process_identity', side_effect=[{'state': 'T'}, {'state': 'S'}]), \
                mock.patch.object(f, 'worker_signal') as send:
            self.assertEqual(f.restore_owned(state()), {'storageRunning': False, 'sameWorkerResumed': True})
            send.assert_called_once_with(state(), signal.SIGCONT)

    def test_restoration_is_idempotent_for_already_running_exact_resources(self):
        with mock.patch.object(f.l, 'owned', return_value={'State': {'Running': True}}), \
                mock.patch.object(f.l, 'process_alive', return_value=True), \
                mock.patch.object(f.l, 'process_identity', return_value={'state': 'S'}), \
                mock.patch.object(f.l, 'run') as command, mock.patch.object(f, 'worker_signal') as send:
            self.assertTrue(all(f.restore_owned(state()).values()))
            command.assert_not_called()
            send.assert_not_called()

    def admission(self, value):
        proof = {'schemaVersion': 1, 'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'namespace': 'vectorix-m7c-s3-outage', 'runId': RUN, 'phase': 'v2-staged', 'faultAdmission': value}
        with mock.patch.object(f.l, 'read_private_bytes', return_value=json.dumps(proof).encode()), \
                mock.patch.object(f, 'read', return_value={'organization': {'id': 'org-owned'}}):
            return f.fresh_admission(state(), 'v2-staged', 'faultAdmission', 'STAGED_ORIGINAL_CONFIRMED', 2)

    def test_staged_admission_binds_actual_original_and_complete_shape(self):
        value = staged()
        result, digest = self.admission(value)
        self.assertEqual(result, value)
        self.assertEqual(len(digest), 64)
        bad = [{**value, 'originalSha256': SHA1}, {**value, 'rustfsContainerId': 'b' * 64},
            {**value, 'extractionPresent': True}, {**value, 'attempts': 1},
            {**value, 'observedAt': datetime.now().isoformat()},
            {**value, 'observedAt': (datetime.now(timezone.utc) - timedelta(seconds=91)).isoformat()},
            {**value, 'unknown': 'not copied'}]
        for invalid in bad:
            with self.subTest(keys=sorted(invalid)):
                with self.assertRaises(f.l.GuardError):
                    self.admission(invalid)

    def test_terminal_proof_requires_five_actual_claims(self):
        value = {key: item for key, item in staged().items() if key in {
            'schemaVersion', 'organizationId', 'documentId', 'versionId', 'version', 'originalSha256', 'observedAt'}}
        value.update(kind='EXTRACTION_FAILED', attempts=4, status='FAILED', errorCode='STORAGE_UNAVAILABLE')
        proof = {'schemaVersion': 1, 'protocolVersion': 2, 'scenario': 'INGESTION_V1', 'namespace': 'vectorix-m7c-s3-outage', 'runId': RUN, 'phase': 'outage-failed', 'faultRecoveryAdmission': value}
        with mock.patch.object(f.l, 'read_private_bytes', return_value=json.dumps(proof).encode()), \
                mock.patch.object(f, 'read', return_value={'organization': {'id': 'org-owned'}}):
            with self.assertRaisesRegex(f.l.GuardError, 'natural-terminal-required'):
                f.fresh_admission(state(), 'outage-failed', 'faultRecoveryAdmission', 'EXTRACTION_FAILED', 2)

    def test_wrong_version_recovery_refuses_before_store_start(self):
        with mock.patch.object(f.l, 'fault_phase', return_value='OUTAGE'), mock.patch.object(f.l, 'guard'), \
                mock.patch.object(f.l, 'watchdog_admission'), \
                mock.patch.object(f, 'fresh_admission', return_value=({'organizationId': 'org', 'documentId': 'doc', 'versionId': 'wrong', 'originalSha256': SHA2}, 'proof')), \
                mock.patch.object(f, 'read', return_value={'staged': {'organizationId': 'org', 'documentId': 'doc', 'versionId': 'right', 'originalSha256': SHA2}}), \
                mock.patch.object(f, 'restore_owned') as restore:
            with self.assertRaisesRegex(f.l.GuardError, 'version-binding'):
                f.restore(state())
            restore.assert_not_called()

    def test_receipts_are_complete_private_and_cannot_overwrite(self):
        with tempfile.TemporaryDirectory(dir=common.CACHE) as temporary, mock.patch.object(f, 'directory', return_value=Path(temporary)):
            target = Path(temporary) / 'test-receipt.json'
            f.record(state(), target.name, {'value': 'original'})
            original = target.read_bytes()
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertFalse((Path(temporary) / '.pending-test-receipt.json').exists())
            with self.assertRaises(FileExistsError):
                f.record(state(), target.name, {'value': 'new'})
            self.assertEqual(target.read_bytes(), original)

    def watchdog_mocks(self, stack, clocks, load):
        events = []
        stack.enter_context(mock.patch.object(f.time, 'monotonic_ns', side_effect=clocks))
        stack.enter_context(mock.patch.object(f.l, 'fault_phase', return_value='NOT_STARTED'))
        stack.enter_context(mock.patch.object(f.l, 'guard'))
        stack.enter_context(mock.patch.object(f, 'fresh_admission', return_value=({'documentId': 'doc'}, 'proof')))
        stack.enter_context(mock.patch.object(f.l, 'process_identity', return_value={
            'uid': os.getuid(), 'startTicks': '1', 'cwd': '/tmp', 'command': [b'python']}))
        stack.enter_context(mock.patch.object(f.Path, 'read_text', return_value='boot'))
        stack.enter_context(mock.patch.object(f.signal, 'signal'))
        first_load = True

        def load_current(run, _scenario):
            nonlocal first_load
            if first_load:
                first_load = False
                return state()
            if isinstance(load, BaseException):
                raise load
            return load(run)

        stack.enter_context(mock.patch.object(f.l, 'load', side_effect=load_current))
        stack.enter_context(mock.patch.object(f.l, 'lifecycle_lock', return_value=contextlib.nullcontext()))
        stack.enter_context(mock.patch.object(f, 'record', side_effect=lambda _state, name, value: events.append((name, value))))
        stack.enter_context(mock.patch.object(f, 'restore_owned', side_effect=lambda _state: events.append(('RESTORE', {})) or {'storageRunning': True, 'sameWorkerResumed': True}))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        return events

    def test_watchdog_control_failure_restores_after_durable_intervention(self):
        with contextlib.ExitStack() as stack:
            events = self.watchdog_mocks(stack, [0, 1], RuntimeError('not logged'))
            f.watchdog(state())
        names = [name for name, _ in events]
        self.assertLess(names.index('watchdog-intervention.json'), names.index('RESTORE'))
        final = dict(events)['watchdog-final.json']
        self.assertTrue(final['intervened'])
        self.assertEqual(final['formalOutcome'], 'INCOMPLETE')

    def test_guard_time_does_not_extend_original_watchdog_budget(self):
        with contextlib.ExitStack() as stack:
            events = self.watchdog_mocks(stack, [0, 300000000000, 901000000000], lambda _run: {'phase': 'READY'})
            f.watchdog(state())
        ack = dict(events)['watchdog-ack.json']
        self.assertEqual(ack['deadlineMonotonicNs'], '900000000000')
        self.assertEqual(dict(events)['watchdog-intervention.json']['reason'], 'ORIGINAL_DEADLINE_EXPIRED')

    def test_enrollment_cannot_publish_ack_after_cleanup_has_started(self):
        with mock.patch.object(f.l, 'lifecycle_lock', return_value=contextlib.nullcontext()), \
                mock.patch.object(f.l, 'load', return_value={**state(), 'phase': 'CLEANING'}), \
                mock.patch.object(f, 'record') as record, mock.patch.object(f.l, 'guard') as guard:
            with self.assertRaisesRegex(f.l.GuardError, 'enrollment-current-state'):
                f.watchdog(state())
            record.assert_not_called()
            guard.assert_not_called()

    def test_entry_refuses_before_state_or_resources_in_either_gate_state(self):
        for disabled in [True, False]:
            with self.subTest(disabled=disabled), mock.patch.object(f, 'STATIC_DRAFT_ONLY', disabled), \
                    mock.patch.object(f.l, 'STATIC_DRAFT_ONLY', False), \
                    mock.patch.object(f.l, 'load', side_effect=AssertionError('must not read state')), \
                    mock.patch.object(f.l, 'run', side_effect=AssertionError('must not access resources')), \
                    mock.patch.object(sys, 'argv', ['fault.py']):
                with self.assertRaises(f.l.GuardError):
                    f.main()


class CleanupFaultTests(unittest.TestCase):
    def cleanup_state(self):
        return {**state(), 'scenario': 'CLEANUP_V1', 'namespace': 'vectorix-m7c-s3-cleanup'}

    def test_scenarios_choose_different_exact_admissions(self):
        plan = f.scenario_plan(self.cleanup_state())
        self.assertEqual(plan['stagedPhase'], 'cleanup-staged')
        self.assertEqual(plan['version'], 1)
        self.assertNotEqual(plan, f.scenario_plan(state()))

    def test_cleanup_requires_625_seconds_of_the_original_deadline(self):
        value = self.cleanup_state()
        ack = {'deadlineMonotonicNs': '900000000000'}
        with mock.patch.object(f.time, 'monotonic_ns', return_value=275000000000):
            f.require_remaining(value, ack)
        with mock.patch.object(f.time, 'monotonic_ns', return_value=275000000001):
            with self.assertRaisesRegex(f.l.GuardError, 'insufficient-original-budget'):
                f.require_remaining(value, ack)
        with mock.patch.object(f.time, 'monotonic_ns', return_value=780000000000):
            f.require_remaining(state(), ack)

    def test_cleanup_budget_is_checked_after_receipt_and_identity_immediately_before_stop(self):
        value = self.cleanup_state()
        staged = {'documentId': 'doc'}
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(f.l, 'fault_phase', return_value='PAUSED'))
            stack.enter_context(mock.patch.object(f.l, 'guard'))
            stack.enter_context(mock.patch.object(f.l, 'watchdog_admission', return_value={
                'deadlineMonotonicNs': '900000000000', 'baseline': {'documentId': 'doc'}}))
            stack.enter_context(mock.patch.object(f, 'fresh_admission', return_value=(staged, 'proof')))
            record = stack.enter_context(mock.patch.object(f, 'record'))
            stack.enter_context(mock.patch.object(f.l, 'owned'))
            stack.enter_context(mock.patch.object(f.time, 'monotonic_ns', return_value=275000000001))
            command = stack.enter_context(mock.patch.object(f.l, 'run'))
            with self.assertRaisesRegex(f.l.GuardError, 'insufficient-original-budget'):
                f.storage_outage(value)
            record.assert_called_once()
            command.assert_not_called()

    def test_abort_marks_incomplete_before_both_safety_restorations(self):
        value = self.cleanup_state()
        events = []
        ack = {'worker': value['processes']['workers'], 'rustfs': value['resources']['rustfs']}
        with mock.patch.object(f, 'read', return_value=ack), mock.patch.object(f.Path, 'exists', return_value=False), \
                mock.patch.object(f, 'record', side_effect=lambda *_: events.append('INTERVENTION')), \
                mock.patch.object(f, 'restore_owned', side_effect=lambda *_: events.append('RESTORE') or {
                    'storageRunning': True, 'sameWorkerResumed': True}):
            f.abort_incomplete(value)
        self.assertEqual(events, ['INTERVENTION', 'RESTORE'])

    def test_abort_rejects_other_enrolled_resources_before_any_signal(self):
        value = self.cleanup_state()
        with mock.patch.object(f, 'read', return_value={'worker': value['processes']['workers'], 'rustfs': {'id': 'other'}}), \
                mock.patch.object(f, 'restore_owned') as restore:
            with self.assertRaisesRegex(f.l.GuardError, 'abort-enrollment-binding'):
                f.abort_incomplete(value)
            restore.assert_not_called()


if __name__ == '__main__':
    unittest.main()
