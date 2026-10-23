"""Pure child-output tests. No actual subprocess, Docker, HTTP, database or model calls."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('quality_topology_outcome', HERE / 'quality-topology.py')
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)
import m7c_restore_common as common

RUN = 'abcdef012345'


def error_output(diagnostic='COLLECTOR_SYNTHETIC_AUTH_REFUSED', **extensions):
    return json.dumps({'completed': False, 'status': 'NOT_RUN_OR_INCOMPLETE',
        'diagnostic': diagnostic, **extensions}).encode()


class FakeSelector:
    """Consume supplied fake pipe events; no real file descriptor is registered."""
    def __init__(self):
        self.items = {}

    def register(self, handle, _events, label):
        self.items[handle] = SimpleNamespace(fd=handle.fd, fileobj=handle, data=label)

    def get_map(self):
        return self.items

    def select(self, timeout):
        return [(item, None) for item in list(self.items.values())]

    def unregister(self, handle):
        del self.items[handle]

    def close(self):
        pass


class CollectorOutcomeTests(unittest.TestCase):
    def test_known_failure_keeps_only_fixed_diagnostic_and_exit(self):
        proof = main.collector_outcome(RUN, 1, b'', error_output())
        self.assertEqual(proof['diagnostic'], 'COLLECTOR_SYNTHETIC_AUTH_REFUSED')
        self.assertEqual(proof['childExitCode'], 1)
        self.assertEqual(proof['result'], 'DID_NOT_PASS')
        self.assertLessEqual(len(main.canonical(proof)), 4096)

    def test_unknown_or_raw_outputs_never_enter_proof(self):
        secret = 'DO_NOT_PERSIST_THIS_SYNTHETIC_SECRET'
        for stderr in [error_output(secret), error_output(raw=secret), secret.encode(),
                error_output() + b'\n' + secret.encode(), b'\xff', b'x' * 4097,
                b'[' * 1500 + b']' * 1500]:
            with self.subTest(stderrBytes=len(stderr)):
                proof = main.collector_outcome(RUN, 1, secret.encode(), stderr)
                self.assertEqual(proof['diagnostic'], 'UNAVAILABLE')
                self.assertNotIn(secret, main.canonical(proof).decode())

    def test_pass_requires_existing_exact_acceptance_shape(self):
        summary = {'runId': RUN, 'status': 'PASS', 'observedQueryCells': 720, 'sourceProofs': 72}
        self.assertEqual(main.collector_outcome(RUN, 0, json.dumps(summary).encode(), b'')['result'], 'PASSED')
        for changed, code in [({**summary, 'runId': 'f' * 12}, 0),
                ({**summary, 'observedQueryCells': 719}, 0), ({**summary, 'sourceProofs': 71}, 0),
                ({**summary, 'status': 'FAIL'}, 0), (summary, 1), ({}, 0)]:
            self.assertEqual(main.collector_outcome(RUN, code, json.dumps(changed).encode(), b'')['result'],
                'DID_NOT_PASS')
        self.assertEqual(main.collector_outcome(RUN, 0, b'{', b'')['result'], 'DID_NOT_PASS')

    def test_proof_input_bounds_are_not_relaxed(self):
        for run, code, stdout, stderr in [('bad', 1, b'', b''), (RUN, True, b'', b''),
                (RUN, 256, b'', b''), (RUN, 1, b'x' * 32769, b''), (RUN, 1, b'', b'x' * 32769)]:
            with self.assertRaises(main.GuardError):
                main.collector_outcome(run, code, stdout, stderr)

    def test_supervisor_persists_private_exclusive_failure_before_refusal(self):
        with tempfile.TemporaryDirectory(dir=common.ROOT / 'node_modules', prefix='vectorix-quality-outcome-') as owned:
            cache = Path(owned) / 'cache'
            directory = cache / ('vectorix-m7c-quality-' + RUN)
            directory.mkdir(parents=True, mode=0o700)
            # The already-owned test parent has normal private modes. No operator cache is used.
            cache.chmod(0o700)
            stdout, stderr = Mock(fd=10), Mock(fd=11)
            child = Mock(pid=987654, stdout=stdout, stderr=stderr)
            child.wait.return_value = 1
            child.poll.return_value = 1
            streams = {10: [b''], 11: [error_output(), b'']}
            state = {'runId': RUN, 'environment': {}, 'collectorProcess': None}
            with patch.object(common, 'CACHE', cache), \
                    patch.object(main, 'state_path', return_value=directory / 'state.json'), \
                    patch.object(main, 'guard'), patch.object(main, 'free_space'), \
                    patch.object(main, 'process_identity', return_value={'startTicks': '12345'}), \
                    patch.object(main.Path, 'read_text', return_value='12345678-1234-1234-1234-123456789abc'), \
                    patch.object(main, 'entry_digest', return_value='a' * 64), patch.object(main, 'save'), \
                    patch.object(main.subprocess, 'Popen', return_value=child) as spawn, \
                    patch.object(main.selectors, 'DefaultSelector', side_effect=FakeSelector), \
                    patch.object(main.os, 'read', side_effect=lambda descriptor, maximum: streams[descriptor].pop(0)):
                with self.assertRaisesRegex(main.GuardError, 'quality-collector-not-passed'):
                    main.supervise_collector(state)
                proof_path = directory / 'collector-outcome.json'
                data = proof_path.read_bytes()
                proof = json.loads(data)
                self.assertEqual(proof['diagnostic'], 'COLLECTOR_SYNTHETIC_AUTH_REFUSED')
                self.assertEqual(proof_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(state['phase'], 'QUALITY_CAPTURE_INCOMPLETE')
                self.assertLessEqual(len(data), 4096)
                spawn.assert_called_once()
                with self.assertRaisesRegex(main.GuardError, 'quality-refuses-existing-capture'):
                    main.supervise_collector(state)
                spawn.assert_called_once()
            child.terminate.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
