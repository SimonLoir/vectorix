"""Explicit one-shot boundary-crash adapter and its independent model-unpause watchdog."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from fault_admission import (FaultRefused, HERE, ROOT, admit_absent, admission, binding,
    enroll, need, observe_boundary, read_context)

STATIC_DRAFT_ONLY = False
PAUSE_LIMIT_NS = 100 * 1_000_000_000
# owned() can perform two bounded10s inspections, followed by a10s unpause and
# two more inspections. Start watchdog cleanup early; a failed control plane is never a confirmed resume.
RESUME_RESERVE_NS = 55 * 1_000_000_000
POLL_SECONDS = 0.1
TRIAL_LIMIT_NS = 15 * 60 * 1_000_000_000


class ClosedParser(argparse.ArgumentParser):
    """Never echo a rejected argument, path, credential or parser error to a terminal."""
    def error(self, _message):
        raise FaultRefused('FAULT_ARGUMENTS')


def exact_parent(q):
    """Record only safe process identity, never command/environment contents."""
    current = q.process_identity(os.getpid())
    need(current is not None and current['uid'] == os.getuid() and current['cwd'] == str(ROOT),
        'FAULT_DRIVER_OWNER_CWD')
    allowed = {'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'VECTORIX_FAULT_RUN', 'VECTORIX_FAULT_ROLE'}
    need(all(item.split(b'=', 1)[0].decode('ascii') in allowed for item in current['environment'] if item),
        'FAULT_DRIVER_INITIAL_ENVIRONMENT')
    for key, value in [('VECTORIX_FAULT_RUN', os.environ.get('VECTORIX_FAULT_RUN')),
                       ('VECTORIX_FAULT_ROLE', 'driver')]:
        need(value and current['environment'].count((key + '=' + value).encode()) == 1,
            'FAULT_DRIVER_INITIAL_ENVIRONMENT')
    need(str(HERE / 'fault_driver.py').encode() in current['command'], 'FAULT_DRIVER_ENTRY')
    return {'pid': os.getpid(), 'startTicks': current['startTicks'],
        'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
        'entrySha256': q.entry_digest(HERE / 'fault_driver.py'), 'runId': os.environ['VECTORIX_FAULT_RUN']}


def parent_alive(q, saved):
    if saved['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        return False
    current = q.process_identity(saved['pid'])
    expected = [('VECTORIX_FAULT_RUN=' + saved['runId']).encode(), b'VECTORIX_FAULT_ROLE=driver']
    return bool(current and current['startTicks'] == saved['startTicks'] and current['uid'] == os.getuid()
        and current['cwd'] == str(ROOT) and str(HERE / 'fault_driver.py').encode() in current['command']
        and all(current['environment'].count(value) == 1 for value in expected)
        and q.entry_digest(HERE / 'fault_driver.py') == saved['entrySha256'])


def checked_control(q, state, directory):
    value = json.loads(q.read_private_bytes(directory / 'fault-control.json', 16384))
    need(type(value) is dict and set(value) == {'schemaVersion', 'runId', 'bindingSha256', 'status',
        'parent', 'pauseDeadlineMonotonicNs', 'modelId', 'trialStartedAtEpochMs',
        'trialDeadlineAtEpochMs', 'trialDeadlineMonotonicNs'} and value['schemaVersion'] == 1
        and value['runId'] == state['runId'] and value['bindingSha256'] == binding(state)
        and value['status'] in {'WATCHDOG_ARMED', 'PAUSE_REQUESTED', 'DISARMED'}
        and value['modelId'] == state['resources']['ollama']['id']
        and type(value['pauseDeadlineMonotonicNs']) is int
        and type(value['trialStartedAtEpochMs']) is int and value['trialStartedAtEpochMs'] > 0
        and value['trialDeadlineAtEpochMs'] == value['trialStartedAtEpochMs'] + TRIAL_LIMIT_NS // 1_000_000
        and value['trialDeadlineMonotonicNs'] - value['pauseDeadlineMonotonicNs'] == TRIAL_LIMIT_NS - PAUSE_LIMIT_NS
        and type(value['parent']) is dict
        and set(value['parent']) == {'pid', 'startTicks', 'bootId', 'entrySha256', 'runId'}
        and type(value['parent']['pid']) is int and value['parent']['pid'] > 1
        and value['parent']['runId'] == state['runId']
        and re.fullmatch(r'[0-9]{1,30}', value['parent']['startTicks'])
        and re.fullmatch(r'[a-f0-9-]{36}', value['parent']['bootId'])
        and re.fullmatch(r'[a-f0-9]{64}', value['parent']['entrySha256']),
        'FAULT_WATCHDOG_CONTROL')
    return value


def unpause_owned(q, state):
    """Cleanup needs exact model ownership, not a live worker or a responsive application database."""
    model = q.owned(state, 'ollama', running=True)
    need(type(model['State'].get('Paused')) is bool, 'FAULT_MODEL_PAUSE_STATE')
    if model['State']['Paused']:
        q.run(['docker', 'unpause', model['Id']], timeout=10)
    after = q.owned(state, 'ollama', running=True)
    need(after['State'].get('Paused') is False, 'FAULT_MODEL_RESUME_UNCONFIRMED')


def watchdog(run_id):
    """Independent bounded process: resume the exact owned model after deadline or driver disappearance."""
    need(not STATIC_DRAFT_ONLY, 'FAULT_DISABLED')
    q, state, _, directory = read_context(run_id)
    need(os.environ.get('VECTORIX_FAULT_RUN') == run_id and os.environ.get('VECTORIX_FAULT_ROLE') == 'watchdog',
        'FAULT_WATCHDOG_ENVIRONMENT')
    control = checked_control(q, state, directory)
    need(parent_alive(q, control['parent']) and os.getppid() == control['parent']['pid']
        and 0 < control['pauseDeadlineMonotonicNs'] - time.monotonic_ns() <= PAUSE_LIMIT_NS,
        'FAULT_WATCHDOG_PARENT_DEADLINE')
    need(not (directory / 'watchdog-ready.json').exists(), 'FAULT_WATCHDOG_REPLAY')
    q.save_json(directory / 'watchdog-ready.json', {'runId': run_id, 'parent': control['parent'],
        'pauseDeadlineMonotonicNs': control['pauseDeadlineMonotonicNs'], 'ready': True})
    deadline, parent = control['pauseDeadlineMonotonicNs'], control['parent']
    while True:
        current = checked_control(q, state, directory)
        need(current['parent'] == parent and current['pauseDeadlineMonotonicNs'] == deadline,
            'FAULT_WATCHDOG_CONTROL_CHANGED')
        if current['status'] == 'DISARMED':
            need(q.owned(state, 'ollama', running=True)['State'].get('Paused') is False,
                'FAULT_MODEL_RESUME_UNCONFIRMED')
            return
        if not parent_alive(q, parent) or time.monotonic_ns() >= deadline - RESUME_RESERVE_NS:
            # A failed pause command can still have been accepted. Inspect even if its caller vanished.
            # The driver can persist PAUSE_REQUESTED and die after this loop read
            # an older WATCHDOG_ARMED value. Inspect/resume idempotently in either
            # case, using only the enrolled exact model identity.
            unpause_owned(q, state)
            q.save_json(directory / 'watchdog-recovery.json', {'runId': run_id,
                'modelResumed': True, 'recoveryAcceptance': 'NOT_OBSERVED'})
            return
        time.sleep(POLL_SECONDS)


def wait_for_boundary(*, observe, deadline, now=time.monotonic_ns, sleep=time.sleep):
    """Pure injected wait: accept only a real processing claim and its single matching live dispatch intent."""
    while now() < deadline:
        row = observe()
        need(now() < deadline, 'FAULT_IN_FLIGHT_CHECKPOINT_MISSED')
        work = row.get('inFlight') or []
        if (row.get('taskStatus') == 'PROCESSING' and row.get('stage') == 'SEMANTIC_PLANNING'
            and row.get('claimLive') is True and len(work) == 1):
            item = work[0]
            if (item.get('state') == 'IN_FLIGHT' and item.get('taskId') == row.get('taskId')
                and item.get('leaseEpoch') == row.get('leaseEpoch') and item.get('dispatchStartedAt')
                and item.get('deadlineLive') is True):
                return row
        sleep(POLL_SECONDS)
    raise FaultRefused('FAULT_IN_FLIGHT_CHECKPOINT_MISSED')


def crash(run_id, scope):
    """One pause + exact pidfd SIGKILL + finally-unpause. It never retries work, restarts apps or edits task state."""
    need(not STATIC_DRAFT_ONLY, 'FAULT_DISABLED')
    q, state, enrollment, directory = read_context(run_id)
    need(os.environ.get('VECTORIX_FAULT_RUN') == run_id and os.environ.get('VECTORIX_FAULT_ROLE') == 'driver',
        'FAULT_DRIVER_ENVIRONMENT')
    need(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'FAULT_PIDFD_REQUIRED')
    with q.state_lock():
        # Re-read after obtaining the ordinary lifecycle lock; no topology state is changed.
        q, state, enrollment, directory = read_context(run_id)
        old_worker = dict(state['processes']['workers'])
        admission(q, state, enrollment, old_worker, absent=False)
        before = observe_boundary(q, state, scope)
        need(not any((directory / name).exists() for name in ['fault-control.json', 'fault-result.json',
            'watchdog-ready.json', 'watchdog-recovery.json']), 'FAULT_ONE_SHOT_REQUIRED')
        started_ns, started_epoch_ms = time.monotonic_ns(), time.time_ns() // 1_000_000
        control = {'schemaVersion': 1, 'runId': run_id, 'bindingSha256': enrollment['bindingSha256'],
            'status': 'WATCHDOG_ARMED', 'parent': exact_parent(q), 'modelId': state['resources']['ollama']['id'],
            'pauseDeadlineMonotonicNs': started_ns + PAUSE_LIMIT_NS,
            'trialStartedAtEpochMs': started_epoch_ms,
            'trialDeadlineAtEpochMs': started_epoch_ms + TRIAL_LIMIT_NS // 1_000_000,
            'trialDeadlineMonotonicNs': started_ns + TRIAL_LIMIT_NS}
        q.save_json(directory / 'fault-control.json', control)
        environment = {**q.base_environment(), 'VECTORIX_FAULT_RUN': run_id, 'VECTORIX_FAULT_ROLE': 'watchdog'}
        child = subprocess.Popen([sys.executable, '-B', str(HERE / 'fault_driver.py'),
            '--run', run_id, '--mode', 'watchdog'], cwd=ROOT, env=environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        resume_confirmed, killed, caught, failure = False, False, None, None
        try:
            ready_deadline = min(time.monotonic_ns() + 5_000_000_000, control['pauseDeadlineMonotonicNs'])
            while not (directory / 'watchdog-ready.json').exists():
                need(child.poll() is None and time.monotonic_ns() < ready_deadline, 'FAULT_WATCHDOG_NOT_READY')
                time.sleep(POLL_SECONDS)
            ready = json.loads(q.read_private_bytes(directory / 'watchdog-ready.json', 4096))
            need(ready == {'runId': run_id, 'parent': control['parent'],
                'pauseDeadlineMonotonicNs': control['pauseDeadlineMonotonicNs'], 'ready': True}, 'FAULT_WATCHDOG_NOT_READY')
            need(child.poll() is None and time.monotonic_ns()
                < control['pauseDeadlineMonotonicNs'] - RESUME_RESERVE_NS - 10_000_000_000,
                'FAULT_PAUSE_DEADLINE')
            control['status'] = 'PAUSE_REQUESTED'
            q.save_json(directory / 'fault-control.json', control)
            model = q.owned(state, 'ollama', running=True)
            need(model['State'].get('Paused') is False, 'FAULT_MODEL_ALREADY_PAUSED')
            q.run(['docker', 'pause', model['Id']], timeout=10)
            need(q.owned(state, 'ollama', running=True)['State'].get('Paused') is True, 'FAULT_MODEL_PAUSE_UNCONFIRMED')
            def observed():
                need(child.poll() is None, 'FAULT_WATCHDOG_LOST')
                return observe_boundary(q, state, scope)
            caught = wait_for_boundary(observe=observed,
                deadline=control['pauseDeadlineMonotonicNs'] - RESUME_RESERVE_NS - 10_000_000_000)
            need(caught['indexedDocumentId'] == before['indexedDocumentId']
                and all(caught[key] == before[key] for key in ['sourceHash', 'profileHash', 'unitManifestHash',
                    'modelIdentity', 'sourceVersionId', 'extractionId', 'extractorVersion', 'buildRevision', 'metadataRevision'])
                and caught['completedUnits'] >= before['completedUnits']
                and caught['boundaryScores'][:len(before['boundaryScores'])] == before['boundaryScores'],
                'FAULT_CANDIDATE_CHANGED')
            # pidfd binds the signal to this process, even if a numeric PID is subsequently recycled.
            descriptor = os.pidfd_open(old_worker['pid'], 0)
            try:
                need(q.read_state(run_id)['processes']['workers'] == old_worker
                    and q.process_alive(state, old_worker), 'FAULT_WORKER_IDENTITY_CHANGED')
                need(q.owned(state, 'ollama', running=True)['State'].get('Paused') is True
                    and child.poll() is None
                    and time.monotonic_ns() < control['pauseDeadlineMonotonicNs'] - RESUME_RESERVE_NS,
                    'FAULT_PAUSE_DEADLINE')
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                killed = True
            finally:
                os.close(descriptor)
            death_deadline = min(time.monotonic_ns() + 5_000_000_000, control['pauseDeadlineMonotonicNs'])
            while q.process_alive(state, old_worker):
                need(time.monotonic_ns() < death_deadline, 'FAULT_WORKER_DEATH_UNCONFIRMED')
                time.sleep(POLL_SECONDS)
        except BaseException as error:
            failure = safe_diagnostic(error)
        finally:
            try:
                unpause_owned(q, state)
                resume_confirmed = True
                control['status'] = 'DISARMED'
                q.save_json(directory / 'fault-control.json', control)
            except BaseException:
                failure = 'FAULT_MODEL_RESUME_UNCONFIRMED'
            # Do not terminate the independent watchdog when resume is unconfirmed.
            if resume_confirmed:
                try:
                    need(child.wait(timeout=5) == 0, 'FAULT_WATCHDOG_NOT_SETTLED')
                except BaseException:
                    failure = failure or 'FAULT_WATCHDOG_NOT_SETTLED'
        result = {'schemaVersion': 1, 'runId': run_id, 'bindingSha256': enrollment['bindingSha256'],
            'status': 'WORKER_KILLED_MODEL_RESUMED' if killed and resume_confirmed and not failure else 'INCOMPLETE',
            'diagnostic': failure, 'oldWorker': old_worker, 'scope': scope, 'before': before, 'caught': caught,
            'recoveryAcceptance': 'NOT_OBSERVED', 'capacityAcceptance': 'NOT_RUN', 'killed': killed,
            'modelResumed': resume_confirmed, 'trialStartedAtEpochMs': control['trialStartedAtEpochMs'],
            'trialDeadlineAtEpochMs': control['trialDeadlineAtEpochMs'],
            'trialDeadlineMonotonicNs': control['trialDeadlineMonotonicNs']}
        q.save_json(directory / 'fault-result.json', result)
        need(result['status'] == 'WORKER_KILLED_MODEL_RESUMED', failure or 'FAULT_ACTION_INCOMPLETE')
        return {'status': result['status'], 'runId': run_id, 'recoveryAcceptance': 'NOT_OBSERVED'}


def main(argv=None):
    need(not STATIC_DRAFT_ONLY, 'FAULT_DISABLED')  # Gate before argument parsing, private reads or resource imports.
    parser = ClosedParser(add_help=False)
    parser.add_argument('--run', required=True)
    parser.add_argument('--mode', choices=['enroll', 'crash', 'absent', 'watchdog'], required=True)
    for name in ['organization', 'collection', 'generation', 'document']:
        parser.add_argument('--' + name)
    args = parser.parse_args(argv)
    if args.mode != 'crash':
        need(all(getattr(args, name) is None for name in ['organization', 'collection', 'generation', 'document']),
            'FAULT_ARGUMENTS')
    if args.mode == 'enroll': return enroll(args.run)
    if args.mode == 'absent': return admit_absent(args.run)
    if args.mode == 'watchdog': return watchdog(args.run)
    return crash(args.run, {name + 'Id': getattr(args, name)
        for name in ['organization', 'collection', 'generation', 'document']})


def safe_diagnostic(error):
    # Only this local error class and known literal codes may reach a public result.
    return str(error) if isinstance(error, FaultRefused) and str(error) in SAFE_DIAGNOSTICS else 'FAULT_ACTION_INCOMPLETE'


SAFE_DIAGNOSTICS = frozenset('''
    FAULT_DISABLED FAULT_ARGUMENTS FAULT_DRIVER_ENVIRONMENT FAULT_DRIVER_INITIAL_ENVIRONMENT
    FAULT_DRIVER_OWNER_CWD FAULT_DRIVER_ENTRY FAULT_PIDFD_REQUIRED FAULT_ONE_SHOT_REQUIRED
    FAULT_WATCHDOG_NOT_READY FAULT_WATCHDOG_LOST FAULT_WATCHDOG_NOT_SETTLED FAULT_WATCHDOG_CONTROL
    FAULT_WATCHDOG_CONTROL_CHANGED FAULT_WATCHDOG_PARENT_DEADLINE FAULT_WATCHDOG_REPLAY
    FAULT_WATCHDOG_ENVIRONMENT FAULT_PAUSE_DEADLINE FAULT_MODEL_ALREADY_PAUSED
    FAULT_MODEL_PAUSE_UNCONFIRMED FAULT_MODEL_PAUSE_STATE FAULT_MODEL_RESUME_UNCONFIRMED
    FAULT_IN_FLIGHT_CHECKPOINT_MISSED FAULT_CANDIDATE_CHANGED FAULT_WORKER_IDENTITY_CHANGED
    FAULT_WORKER_DEATH_UNCONFIRMED FAULT_ACTION_INCOMPLETE
'''.split())


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except BaseException as error:
        print(json.dumps({'status': 'REFUSED_OR_INCOMPLETE', 'diagnostic': safe_diagnostic(error),
            'recoveryAcceptance': 'NOT_OBSERVED'}))
        sys.exit(1)
