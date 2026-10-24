"""Offline Redis admission/fault refusals. Every socket, signal and Docker call is mocked."""
import contextlib
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import signal
import sys
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 's3-outage'))
sys.path.insert(0, str(HERE))
import lifecycle as l
import fault as f
import redis_queue as q


def state(scenario='REDIS_V1'):
    return {'schemaVersion': 1, 'protocolVersion': 2, 'scenario': scenario,
        'namespace': l.scenario_spec(scenario)['namespace'], 'runId': '123456abcdef',
        'phase': 'READY', 'ports': {'redis': 12345},
        'resources': {name: {'id': ('c' if name == 'redis' else 'a') * 64} for name in l.SERVICES},
        'processes': {name: {'pid': index + 100, 'service': name, 'startTicks': '42'} for index, name in enumerate(l.APPS)}}


def handle(replies):
    stream = mock.MagicMock()
    stream.recv.side_effect = [bytes([part]) for part in replies]
    stream.__enter__.return_value = stream
    return stream


class RedisTests(unittest.TestCase):
    def test_disabled_and_wrong_scenario_refuse_before_connect(self):
        connect = mock.Mock()
        with self.assertRaisesRegex(l.GuardError, 'draft-review'):
            q.read_queue(state(), mock.Mock(), l.require, connect=connect)
        with mock.patch.object(q, 'STATIC_DRAFT_ONLY', False):
            with self.assertRaisesRegex(l.GuardError, 'queue-scenario'):
                q.read_queue(state('INGESTION_V1'), mock.Mock(), l.require, connect=connect)
        connect.assert_not_called()

    def test_actual_guard_precedes_only_two_fixed_read_commands_and_rechecks(self):
        events = []
        stream = handle(b':0\r\n*2\r\n$7\r\nscan:21\r\n$13\r\n1761397200000\r\n')
        def connect(address, timeout):
            events.append(('connect', address, timeout))
            return stream
        with mock.patch.object(q, 'STATIC_DRAFT_ONLY', False):
            value = q.read_queue(state(), lambda: events.append('admit'), l.require, connect=connect)
        self.assertEqual(events[0], 'admit')
        self.assertEqual(events[-1], 'admit')
        self.assertEqual(events[1], ('connect', ('127.0.0.1', 12345), 2))
        self.assertEqual(value['activeDocumentScans'], 0)
        self.assertEqual(value['latestCompletedDocumentScan'], {'jobSha256': hashlib.sha256(b'scan:21').hexdigest(), 'completedAtMilliseconds': 1761397200000})
        self.assertNotIn('scan:21', str(value))
        self.assertEqual(stream.sendall.call_args_list, [
            mock.call(b'*2\r\n$4\r\nLLEN\r\n$21\r\nbull:documents:active\r\n'),
            mock.call(b'*5\r\n$9\r\nZREVRANGE\r\n$24\r\nbull:documents:completed\r\n$1\r\n0\r\n$1\r\n0\r\n$10\r\nWITHSCORES\r\n')])
        stream.__exit__.assert_called_once()

    def test_failed_admission_never_connects_even_with_gate_open(self):
        connect = mock.Mock()
        def refuse():
            raise l.GuardError('mock-owned-identity-refused')
        with mock.patch.object(q, 'STATIC_DRAFT_ONLY', False):
            with self.assertRaisesRegex(l.GuardError, 'identity-refused'):
                q.read_queue(state(), refuse, l.require, connect=connect)
        connect.assert_not_called()

    def test_error_text_unbounded_reply_and_counter_overflow_are_finite_refusals(self):
        for reply, diagnostic in [(b'-ERR private-provider-text\r\n', 'integer-required'),
                (b':' + b'1' * 40, 'response-bound'), (b':1000000001\r\n', 'count-bound')]:
            with self.subTest(diagnostic=diagnostic):
                with self.assertRaisesRegex(l.GuardError, diagnostic) as error:
                    q.integer_reply(handle(reply), time.monotonic() + 4, l.require)
                self.assertNotIn('private-provider-text', str(error.exception))

    def test_completed_tuple_empty_and_malformed_responses_are_bounded(self):
        self.assertIsNone(q.completed_reply(handle(b'*0\r\n'), time.monotonic() + 4, l.require))
        for reply in [b'*4\r\n', b'*2\r\n$161\r\n',
                b'*2\r\n$1\r\na\r\n$16\r\n9007199254740992\r\n',
                b'*2\r\n$3\r\nab\r\n', b'-ERR private-value\r\n']:
            with self.subTest(reply_length=len(reply)), self.assertRaises(l.GuardError) as error:
                q.completed_reply(handle(reply), time.monotonic() + 4, l.require)
            self.assertNotIn('private-value', str(error.exception))

    def test_deadline_is_shared_across_reply_bytes_not_refreshed_per_read(self):
        clock = [0]
        stream = handle(b':0\r\n')
        def recv(_count):
            clock[0] += 2
            return b':'
        stream.recv.side_effect = recv
        with self.assertRaisesRegex(l.GuardError, 'response-bound'):
            q.integer_reply(stream, 4, l.require, monotonic=lambda: clock[0])
        self.assertLessEqual(stream.recv.call_count, 2)

    def test_redis_pause_requires_transfer_flag_and_never_accepts_browser_selection(self):
        for flag in ['--file-selected', '--fixture-ready']:
            with mock.patch.object(f, 'STATIC_DRAFT_ONLY', False), mock.patch.object(l, 'STATIC_DRAFT_ONLY', False), \
                    mock.patch.object(l, 'load', side_effect=AssertionError('no state read')) as load, \
                    mock.patch.object(sys, 'argv', ['fault.py','--run','123456abcdef','--scenario','REDIS_V1','--mode','pause-worker',flag]):
                with self.assertRaisesRegex(l.GuardError, 'selection-arguments'):
                    f.main()
                load.assert_not_called()

    def test_scenarios_choose_only_their_fixed_dependency(self):
        self.assertEqual(l.fault_store(state()), 'redis')
        self.assertEqual(l.fault_store(state('INGESTION_V1')), 'rustfs')
        self.assertEqual(l.fault_store(state('CLEANUP_V1')), 'rustfs')
        with self.assertRaises(l.GuardError):
            l.fault_store({'scenario': 'OTHER'})
        self.assertEqual(l.outage_receipt_name(state()), 'fault-redis-outage-receipt.json')

    def test_outage_guard_requires_redis_down_and_s3_online_without_reusing_s3_fault(self):
        value = state()
        calls = []
        with contextlib.ExitStack() as stack:
            for name, fn in [('pins', lambda *_: None), ('schema', lambda *_: None),
                    ('smtp_ready', lambda *_: None), ('fault_phase', lambda *_: 'OUTAGE'),
                    ('owned', lambda _s, service, running=None: calls.append((service, running))),
                    ('process_alive', lambda *_: True), ('process_identity', lambda *_: {'state': 'S'}),
                    ('watchdog_admission', lambda *_: {})]:
                stack.enter_context(mock.patch.object(l, name, fn))
            proof = l.guard(value, 'outage-observe')
        self.assertTrue(proof['resourceOwnership'])
        self.assertIn(('redis', False), calls)
        self.assertIn(('rustfs', True), calls)
        self.assertEqual(sum(running is False for _, running in calls), 1)

    def fault_context(self, value, active=0):
        stack = contextlib.ExitStack()
        records = []
        for name, fn in [('fault_phase', lambda *_: 'PAUSED'), ('guard', lambda *_: {}),
                ('watchdog_admission', lambda *_: {'deadlineMonotonicNs': str(time.monotonic_ns() + 900_000_000_000),
                    'baselineSha256': 'b' * 64, 'baseline':{'documentId':'doc','organizationId':'org'}}), ('owned', mock.Mock()), ('run', mock.Mock())]:
            stack.enter_context(mock.patch.object(l, name, fn))
        stack.enter_context(mock.patch.object(f, 'fresh_admission', return_value=({'documentId':'doc','organizationId':'org','versionId':'v2','originalSha256':'2'*64},'e'*64)))
        stack.enter_context(mock.patch.object(f, 'queue_observation', return_value={'activeDocumentScans': active, 'latestCompletedDocumentScan': {'jobSha256': 'd' * 64, 'completedAtMilliseconds': 1761397200000}}))
        stack.enter_context(mock.patch.object(f, 'record', side_effect=lambda _s, filename, body: records.append((filename, body))))
        send = stack.enter_context(mock.patch.object(f, 'worker_signal'))
        return stack, records, send

    def test_real_redis_stop_control_uses_exact_saved_id_and_resumes_same_worker(self):
        value = state()
        stack, records, send = self.fault_context(value)
        with stack:
            f.redis_outage(value)
            l.run.assert_called_once_with(['docker', 'stop', '-t', '10', value['resources']['redis']['id']], timeout=15)
            send.assert_called_once_with(value, signal.SIGCONT)
            self.assertEqual([row[0] for row in records], ['fault-redis-outage-intent.json', 'fault-redis-outage-receipt.json'])
            self.assertEqual(records[-1][1]['redis'], value['resources']['redis'])
            self.assertEqual(records[-1][1]['worker'], value['processes']['workers'])
            self.assertEqual(records[-1][1]['queueBefore']['latestCompletedDocumentScan']['completedAtMilliseconds'], 1761397200000)

    def test_missing_pre_cut_acceptance_refuses_before_queue_or_storage_mutation(self):
        value=state();stack,records,send=self.fault_context(value)
        with stack, mock.patch.object(f,'fresh_admission',side_effect=l.GuardError('mock-staged-proof-required')), mock.patch.object(f,'queue_observation') as queue:
            with self.assertRaisesRegex(l.GuardError,'staged-proof-required'):
                f.redis_outage(value)
            queue.assert_not_called();l.run.assert_not_called();send.assert_not_called();self.assertEqual(records,[])

    def test_real_staged_admission_requires_exact_stored_unclaimed_v2_and_owned_containers(self):
        value=state();value['inputs']={'textFixtures':{'s3-outage-v2.txt':{'sha256':'2'*64}}}
        staged={'schemaVersion':1,'kind':'STAGED_ORIGINAL_CONFIRMED','organizationId':'org','documentId':'doc','versionId':'v2','version':2,
            'originalSha256':'2'*64,'observedAt':datetime.now(timezone.utc).isoformat(),'workerPid':value['processes']['workers']['pid'],
            'workerStartTicks':'42','rustfsContainerId':'a'*64,'redisContainerId':'c'*64,
            'stored':True,'ingestionStatus':'PENDING','attempts':0,'extractionPresent':False,'liveClaims':0}
        def admit(row):
            proof={**l.receipt_scope(value),'namespace':value['namespace'],'phase':'redis-staged','status':'OBSERVED','faultAdmission':row}
            with mock.patch.object(l,'read_private_bytes',return_value=json.dumps(proof).encode()),mock.patch.object(f,'read',return_value={'organization':{'id':'org'}}):
                return f.fresh_admission(value,'redis-staged','faultAdmission','STAGED_ORIGINAL_CONFIRMED',2)
        self.assertEqual(admit(staged)[0],staged)
        for delta in [{'liveClaims':1},{'stored':False},{'attempts':1},{'version':1},{'redisContainerId':'f'*64},{'extractionPresent':True}]:
            with self.assertRaises(l.GuardError):admit({**staged,**delta})

    def test_admitted_active_scan_refuses_before_any_stop_or_receipt(self):
        value = state()
        stack, records, send = self.fault_context(value, active=1)
        with stack:
            with self.assertRaisesRegex(l.GuardError, 'active-scan-incomplete'):
                f.redis_outage(value)
            l.run.assert_not_called()
            send.assert_not_called()
            self.assertEqual(records, [])

    def test_safety_restoration_targets_redis_and_attempts_worker_resume_even_if_start_fails(self):
        value = state()
        with mock.patch.object(l, 'owned', return_value={'State': {'Running': False}}), \
                mock.patch.object(l, 'run', side_effect=l.GuardError('mock-start-refused')) as run, \
                mock.patch.object(l, 'process_alive', return_value=True), \
                mock.patch.object(l, 'process_identity', side_effect=[{'state': 'T'}, {'state': 'S'}]), \
                mock.patch.object(f, 'worker_signal') as send:
            result = f.restore_owned(value)
        self.assertEqual(result, {'redisRunning': False, 'sameWorkerResumed': True})
        run.assert_called_once_with(['docker', 'start', value['resources']['redis']['id']], timeout=30)
        send.assert_called_once_with(value, signal.SIGCONT)


if __name__ == '__main__':
    unittest.main()
