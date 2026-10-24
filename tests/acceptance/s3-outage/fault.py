"""Disabled, one-run S3 fault controls and independent 900-second safety watchdog."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

import lifecycle as l
sys.path.insert(0, str(l.HERE.parent / 'redis-outage'))
import redis_queue as queue_reader

STATIC_DRAFT_ONLY = True
BUDGET_SECONDS = 900
MAX_PROOF_AGE_SECONDS = 90


def stamp():
    return datetime.now(timezone.utc).isoformat()


def directory(state):
    return l.state_path(state['runId'], state['scenario']).parent


def record(state, filename, value):
    """Publish a complete private receipt atomically using a no-overwrite hard link."""
    target = directory(state) / filename
    temporary = target.with_name('.pending-' + filename)
    l.private_directory(target.parent)
    l.save_json(temporary, {**l.receipt_scope(state), **value}, exclusive=True)
    descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.link(temporary.name, target.name, src_dir_fd=descriptor, dst_dir_fd=descriptor, follow_symlinks=False)
        os.fsync(descriptor)
        os.unlink(temporary.name, dir_fd=descriptor)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read(state, filename, maximum=32768):
    value = json.loads(l.read_private_bytes(directory(state) / filename, maximum))
    l.require(l.receipt_matches(state, value), 'm7c-s3-outage-fault-file-scope')
    return value


def require_clean_evidence(state):
    l.require(not (directory(state) / 'watchdog-intervention.json').exists(),
        'm7c-s3-outage-watchdog-intervened-incomplete')


def fresh_admission(state, phase, field, kind, version):
    """Consume the independent observer's exact source evidence, never an operator-invented ID."""
    filename = directory(state) / ('observe-' + phase + '.json')
    raw = l.read_private_bytes(filename, 32768)
    proof = json.loads(raw)
    fixture = read(state, 'fixture.json', 16384)
    l.require(isinstance(proof, dict), 'm7c-s3-outage-observer-proof-scope')
    value = proof.get(field)
    if state['scenario'] == 'REDIS_V1':
        l.require(proof.get('status') == 'OBSERVED', 'm7c-redis-complete-observer-required')
    l.require(isinstance(proof, dict) and l.receipt_matches(state, proof)
        and proof.get('namespace') == state['namespace']
        and proof.get('phase') == phase and isinstance(value, dict), 'm7c-s3-outage-observer-proof-scope')
    common = {'schemaVersion', 'kind', 'organizationId', 'documentId', 'versionId',
        'version', 'originalSha256', 'observedAt'}
    extras = {'faultEnrollmentAdmission': {'liveClaims', 'workerPid', 'workerStartTicks', 'rustfsContainerId'},
        'faultAdmission': {'stored', 'ingestionStatus', 'attempts', 'extractionPresent',
            'workerPid', 'workerStartTicks', 'rustfsContainerId'},
        'faultRecoveryAdmission': {'attempts', 'status', 'errorCode'}}
    if state['scenario'] == 'REDIS_V1':
        extras['faultAdmission'] = extras['faultAdmission'] | {'redisContainerId', 'liveClaims'}
        extras['faultEnrollmentAdmission'] = extras['faultEnrollmentAdmission'] | {'redisContainerId'}
        extras['faultRecoveryAdmission'] = extras['faultRecoveryAdmission'] | {'pendingSnapshots', 'pendingWallObservedMilliseconds', 'pendingMonotonicObservedMilliseconds', 'redisContainerId'}
    if state['scenario'] == 'CLEANUP_V1':
        extras = {
            'faultEnrollmentAdmission': extras['faultEnrollmentAdmission'],
            'faultAdmission': {'cleanupStatus', 'attempts', 'liveClaims', 'scheduledAt', 'workerPid', 'workerStartTicks', 'rustfsContainerId'},
            'faultRecoveryAdmission': {'attempts', 'status', 'errorCode', 'scheduledAt'},
        }
    l.require(field in extras and set(value) == common | extras[field]
        and value.get('schemaVersion') == 1 and value.get('kind') == kind and value.get('version') == version
        and value.get('organizationId') == fixture.get('organization', {}).get('id')
        and all(isinstance(value.get(key), str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', value[key])
            for key in ['organizationId', 'documentId', 'versionId'])
        and value.get('originalSha256') == state['inputs']['textFixtures']['s3-outage-v' + str(version) + '.txt']['sha256'],
        'm7c-s3-outage-observer-source-binding')
    observed = value.get('observedAt')
    l.require(isinstance(observed, str) and len(observed) <= 64
        and (observed.endswith('Z') or observed.endswith('+00:00')), 'm7c-s3-outage-observer-aware-time')
    try:
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(observed.replace('Z', '+00:00'))).total_seconds()
    except (ValueError, TypeError):
        raise l.GuardError('m7c-s3-outage-observer-aware-time') from None
    l.require(0 <= elapsed <= MAX_PROOF_AGE_SECONDS, 'm7c-s3-outage-observer-proof-stale')
    if field in {'faultEnrollmentAdmission', 'faultAdmission'}:
        l.require(value['workerPid'] == state['processes']['workers']['pid']
            and value['workerStartTicks'] == state['processes']['workers']['startTicks']
            and value['rustfsContainerId'] == state['resources']['rustfs']['id'], 'm7c-s3-outage-observer-process-binding')
    if state['scenario'] == 'REDIS_V1':
        l.require(value.get('redisContainerId') == state['resources']['redis']['id'], 'm7c-redis-observer-store-binding')
    if field == 'faultEnrollmentAdmission':
        l.require(value['liveClaims'] == 0, 'm7c-s3-outage-baseline-idle')
    elif field == 'faultAdmission' and state['scenario'] == 'CLEANUP_V1':
        l.require(value['cleanupStatus'] == 'PENDING' and value['attempts'] == 0 and value['liveClaims'] == 0
            and isinstance(value['scheduledAt'], str), 'm7c-s3-outage-cleanup-unclaimed-required')
    elif field == 'faultAdmission':
        l.require(value['stored'] is True and value['ingestionStatus'] == 'PENDING' and value['attempts'] == 0
            and value['extractionPresent'] is False
            and (state['scenario'] != 'REDIS_V1' or (type(value['liveClaims']) is int and value['liveClaims'] == 0)), 'm7c-s3-outage-staged-original-required')
    elif state['scenario'] == 'REDIS_V1':
        l.require(value['attempts'] == 0 and value['status'] == 'PENDING' and value['errorCode'] is None
            and type(value['pendingSnapshots']) is int and 3 <= value['pendingSnapshots'] <= 12
            and all(type(value[key]) in {int, float} and 15000 <= value[key] <= 60000
                for key in ['pendingWallObservedMilliseconds', 'pendingMonotonicObservedMilliseconds']), 'm7c-redis-observed-pending-required')
    else:
        l.require(value['attempts'] == 5 and value['status'] == 'FAILED' and value['errorCode'] == 'STORAGE_UNAVAILABLE',
            'm7c-s3-outage-natural-terminal-required')
    return value, l.digest(raw)


def scenario_plan(state):
    l.scenario_spec(state['scenario'])
    if state['scenario'] == 'REDIS_V1':
        return {'baselinePhase': 'redis-ready', 'baselineKind': 'V1_READY_IDLE',
            'stagedPhase':'redis-staged','stagedKind':'STAGED_ORIGINAL_CONFIRMED',
            'failedPhase': 'redis-pending', 'failedKind': 'REDIS_PENDING_CONFIRMED', 'version': 2}
    if state['scenario'] == 'INGESTION_V1':
        return {'baselinePhase': 'v1-ready', 'baselineKind': 'V1_READY_IDLE',
            'stagedPhase': 'v2-staged', 'stagedKind': 'STAGED_ORIGINAL_CONFIRMED',
            'failedPhase': 'outage-failed', 'failedKind': 'EXTRACTION_FAILED', 'version': 2}
    return {'baselinePhase': 'cleanup-ready', 'baselineKind': 'CLEANUP_READY_IDLE',
        'stagedPhase': 'cleanup-staged', 'stagedKind': 'CLEANUP_DELETE_ACCEPTED',
        'failedPhase': 'cleanup-outage-failed', 'failedKind': 'CLEANUP_FAILED', 'version': 1}


def require_remaining(state, ack):
    minimum = 625 if state['scenario'] == 'CLEANUP_V1' else 120
    l.require(int(ack['deadlineMonotonicNs']) - time.monotonic_ns() >= minimum * 1000000000,
        'm7c-s3-outage-insufficient-original-budget')


def abort_incomplete(state):
    """Restore only enrolled identities; an immutable intervention permanently forbids PASS."""
    ack = read(state, 'watchdog-ack.json', 8192)
    l.require(ack.get('worker') == state['processes']['workers'] and ack.get('rustfs') == state['resources']['rustfs']
        and (state['scenario'] != 'REDIS_V1' or ack.get('redis') == state['resources']['redis']),
        'm7c-s3-outage-abort-enrollment-binding')
    try:
        if not (directory(state) / 'watchdog-intervention.json').exists():
            record(state, 'watchdog-intervention.json', {'at': stamp(), 'reason': 'INCOMPLETE_CONTROL_REQUESTED',
                'formalOutcome': 'INCOMPLETE'})
        else:
            read(state, 'watchdog-intervention.json')
    finally:
        result = restore_owned(state)
    l.require(all(result.values()), 'm7c-s3-outage-abort-restore-incomplete')


def worker_signal(state, action):
    """Signal only the enrolled worker after identity checks on both sides of pidfd acquisition."""
    l.require(action in {signal.SIGSTOP, signal.SIGCONT}, 'm7c-s3-outage-worker-signal')
    saved = state['processes']['workers']
    l.require(l.process_alive(state, saved), 'm7c-s3-outage-worker-identity-required')
    descriptor = os.pidfd_open(saved['pid'])
    try:
        l.require(l.process_alive(state, saved), 'm7c-s3-outage-worker-identity-required')
        signal.pidfd_send_signal(descriptor, action)
    finally:
        os.close(descriptor)
    until = time.monotonic() + 3
    while True:
        l.require(l.process_alive(state, saved), 'm7c-s3-outage-worker-identity-required')
        actual = l.process_identity(saved['pid'])
        if (actual['state'] == 'T') if action == signal.SIGSTOP else actual['state'] not in {'T', 't'}:
            return
        l.require(time.monotonic() < until, 'm7c-s3-outage-worker-signal-timeout')
        time.sleep(0.02)


def restore_owned(state):
    """Safety restoration tries both independent actions; a failed store start must not strand a stopped worker."""
    storage_restored, worker_resumed = False, False
    service = l.fault_service(state)
    try:
        value = l.owned(state, service)
        if value['State']['Running'] is False:
            l.run(['docker', 'start', state['resources'][service]['id']], timeout=30)
        l.owned(state, service, running=True)
        storage_restored = True
    except BaseException:
        pass
    try:
        saved = state['processes']['workers']
        l.require(l.process_alive(state, saved), 'm7c-s3-outage-worker-identity-required')
        if l.process_identity(saved['pid'])['state'] == 'T':
            worker_signal(state, signal.SIGCONT)
        l.require(l.process_identity(saved['pid'])['state'] not in {'T', 't'}, 'm7c-s3-outage-worker-still-stopped')
        worker_resumed = True
    except BaseException:
        pass
    return {('redisRunning' if service == 'redis' else 'storageRunning'): storage_restored, 'sameWorkerResumed': worker_resumed}


def watchdog_reason(now_ns, deadline_ns, stopped, cleaning):
    if stopped:
        return 'CONTROL_TERMINATED'
    if cleaning:
        return 'CLEANUP_REQUESTED'
    if now_ns >= deadline_ns:
        return 'ORIGINAL_DEADLINE_EXPIRED'
    return None


def watchdog(state):
    """An independent foreground process owns the only 900-second monotonic deadline; it is never refreshed."""
    enrolled_ns = time.monotonic_ns()
    enrolled_at = datetime.now(timezone.utc)
    deadline_ns = enrolled_ns + BUDGET_SECONDS * 1000000000
    with l.lifecycle_lock(state['scenario']):
        current = l.load(state['runId'], state['scenario'])
        l.require(current['phase'] == 'READY' and current['processes'] == state['processes']
            and current['resources'] == state['resources'], 'm7c-s3-outage-enrollment-current-state')
        l.require(l.fault_phase(state) == 'NOT_STARTED', 'm7c-s3-outage-watchdog-no-replay')
        l.guard(state, 'observe')
        plan = scenario_plan(state)
        baseline, baseline_sha = fresh_admission(state, plan['baselinePhase'], 'faultEnrollmentAdmission', plan['baselineKind'], 1)
        l.require(time.monotonic_ns() < deadline_ns, 'm7c-s3-outage-enrollment-budget')
        record(state, 'watchdog-intent.json', {'at': stamp(), 'status': 'ENROLLING_NO_REPLAY'})
        identity = l.process_identity(os.getpid())
        l.require(identity is not None and identity['uid'] == os.getuid(), 'm7c-s3-outage-control-identity')
        control = {'pid': os.getpid(), 'startTicks': identity['startTicks'], 'cwd': identity['cwd'],
            'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'commandSha256': l.digest(b'\0'.join(identity['command']))}
        stop = False

        def terminate(_signal, _frame):
            nonlocal stop
            stop = True

        for code in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(code, terminate)
        ack = {'control': control, 'worker': state['processes']['workers'], 'rustfs': state['resources']['rustfs'],
            'budgetSeconds': BUDGET_SECONDS, 'enrolledAt': enrolled_at.isoformat(),
            'deadlineAt': datetime.fromtimestamp(enrolled_at.timestamp() + BUDGET_SECONDS, timezone.utc).isoformat(),
            'deadlineMonotonicNs': str(deadline_ns), 'baselineSha256': baseline_sha, 'baseline': baseline}
        if state['scenario'] == 'REDIS_V1':
            ack['redis'] = state['resources']['redis']
        record(state, 'watchdog-ack.json', ack)
        print(json.dumps({**l.receipt_scope(state), 'completed': True, 'operation': 'watchdog-ack', 'runId': state['runId'], 'budgetSeconds': BUDGET_SECONDS}), flush=True)
    # No lifecycle lock is held: control-tool failures cannot block this independent safety path.
    reason = None
    try:
        while True:
            current = l.load(state['runId'], state['scenario'])
            if (directory(state) / 'watchdog-intervention.json').exists():
                read(state, 'watchdog-intervention.json')
                reason = 'INCOMPLETE_CONTROL_REQUESTED'
                break
            reason = watchdog_reason(time.monotonic_ns(), deadline_ns, stop, current['phase'] == 'CLEANING')
            if reason is not None:
                break
            if l.fault_phase(state) in {'RESTORED', 'COMPLETE'}:
                l.owned(state, l.fault_service(state), running=True)
                l.require(l.process_alive(state, state['processes']['workers'])
                    and l.process_identity(state['processes']['workers']['pid'])['state'] not in {'T', 't'},
                    'm7c-s3-outage-operator-restoration-not-confirmed')
                record(state, 'watchdog-final.json', {'at': stamp(), 'intervened': False, 'formalOutcome': 'NOT_DETERMINED',
                    ('redisRunning' if state['scenario'] == 'REDIS_V1' else 'storageRunning'): True, 'sameWorkerResumed': True})
                return
            time.sleep(min(0.25, max(0.001, (deadline_ns - time.monotonic_ns()) / 1000000000)))
    except BaseException:
        reason = 'WATCHDOG_CONTROL_FAILURE'
    # Persist intervention before touching resources; even later successful recovery cannot turn it into PASS.
    # Restoration still runs if evidence persistence itself fails.
    try:
        if not (directory(state) / 'watchdog-intervention.json').exists():
            record(state, 'watchdog-intervention.json', {'at': stamp(), 'reason': reason, 'formalOutcome': 'INCOMPLETE'})
        else:
            read(state, 'watchdog-intervention.json')
    finally:
        result = restore_owned(state)
    record(state, 'watchdog-final.json', {'at': stamp(), 'intervened': True, 'formalOutcome': 'INCOMPLETE', **result})
    l.require(all(result.values()), 'm7c-s3-outage-watchdog-restore-incomplete')


def pause_worker(state, confirmed):
    l.require(confirmed is True and l.fault_phase(state) == 'ARMED', 'm7c-s3-outage-readiness-before-pause')
    l.guard(state, 'observe')
    ack = l.watchdog_admission(state)
    record(state, 'fault-pause-intent.json', {'at': stamp(), 'watchdogAckSha256': l.digest(l.read_private_bytes(directory(state) / 'watchdog-ack.json', 8192)),
        'readinessEvidence': ('PINNED_NATIVE_CURL_TRANSFER_FIXTURE_READY' if state['scenario'] == 'REDIS_V1' else 'OPERATOR_FILE_SELECTION_CONFIRMED_NOT_DOM_OBSERVATION' if state['scenario'] == 'INGESTION_V1' else 'INDEPENDENT_READY_FIXTURE_CONFIRMED')})
    worker_signal(state, signal.SIGSTOP)
    l.watchdog_admission(state)
    record(state, 'fault-pause-receipt.json', {'at': stamp(), 'sameWorker': ack['worker'], 'readinessConfirmedBeforePause': True})


def queue_observation(state, purpose):
    """Inspect only fixed queue counters, after full pins/identity and again after I/O."""
    l.require(state['scenario'] == 'REDIS_V1', 'm7c-redis-queue-scenario')
    return queue_reader.read_queue(state, lambda: l.guard(state, purpose), l.require)


def redis_outage(state):
    """Stop the enrolled queue while the worker is paused, then resume that same PID."""
    l.require(state['scenario'] == 'REDIS_V1' and l.fault_phase(state) == 'PAUSED', 'm7c-redis-outage-phase')
    l.guard(state, 'staged-observe')
    ack = l.watchdog_admission(state)
    staged, staged_sha = fresh_admission(state,'redis-staged','faultAdmission','STAGED_ORIGINAL_CONFIRMED',2)
    l.require(staged['documentId'] == ack['baseline']['documentId'] and staged['organizationId'] == ack['baseline']['organizationId'],
        'm7c-redis-staged-document-binding')
    before = queue_observation(state, 'staged-observe')
    l.require(before['activeDocumentScans'] == 0, 'm7c-redis-active-scan-incomplete')
    record(state, 'fault-redis-outage-intent.json', {'at': stamp(), 'queueBefore': before,
        'redis': state['resources']['redis'], 'baselineSha256': ack['baselineSha256'], 'stagedProofSha256': staged_sha, 'staged': staged})
    l.owned(state, 'redis', running=True)
    require_remaining(state, ack)
    l.run(['docker', 'stop', '-t', '10', state['resources']['redis']['id']], timeout=15)
    l.owned(state, 'redis', running=False)
    l.watchdog_admission(state)
    worker_signal(state, signal.SIGCONT)
    l.watchdog_admission(state)
    record(state, 'fault-redis-outage-receipt.json', {'at': stamp(), 'queueBefore': before,
        'redisStopped': True, 'sameWorkerResumed': True,
        'worker': state['processes']['workers'], 'redis': state['resources']['redis'],
        'baselineSha256': ack['baselineSha256'], 'stagedProofSha256':staged_sha, 'staged':staged,
        'scope': 'ACTIVE_ZERO_IS_NOT_AN_ATOMIC_IN_FLIGHT_COMMAND_BARRIER'})


def storage_outage(state):
    l.require(state['scenario'] in {'INGESTION_V1', 'CLEANUP_V1'}
        and l.fault_phase(state) == 'PAUSED', 'm7c-s3-outage-storage-outage-phase')
    l.guard(state, 'staged-observe')
    ack = l.watchdog_admission(state)
    plan = scenario_plan(state)
    staged, staged_sha = fresh_admission(state, plan['stagedPhase'], 'faultAdmission', plan['stagedKind'], plan['version'])
    l.require(staged['documentId'] == ack['baseline']['documentId'], 'm7c-s3-outage-replacement-document-binding')
    record(state, 'fault-storage-outage-intent.json', {'at': stamp(), 'stagedProofSha256': staged_sha,
        'rustfs': state['resources']['rustfs'], 'staged': staged})
    l.owned(state, 'rustfs', running=True)
    require_remaining(state, ack)  # Last check immediately before the destructive store stop.
    l.run(['docker', 'stop', '-t', '55', state['resources']['rustfs']['id']], timeout=60)
    l.owned(state, 'rustfs', running=False)
    l.watchdog_admission(state)
    worker_signal(state, signal.SIGCONT)
    l.watchdog_admission(state)
    record(state, 'fault-storage-outage-receipt.json', {'at': stamp(), 'stagedProofSha256': staged_sha,
        'staged': staged, 'storageStopped': True, 'sameWorkerResumed': True,
        'worker': state['processes']['workers'], 'rustfs': state['resources']['rustfs']})


def restore(state):
    l.require(l.fault_phase(state) == 'OUTAGE', 'm7c-s3-outage-restoration-phase')
    l.guard(state, 'outage-observe')
    l.watchdog_admission(state)
    plan = scenario_plan(state)
    failed, failed_sha = fresh_admission(state, plan['failedPhase'], 'faultRecoveryAdmission', plan['failedKind'], plan['version'])
    if state['scenario'] == 'REDIS_V1':
        staged = read(state, 'fault-redis-outage-receipt.json', 16384)['staged']
        l.require(failed['organizationId'] == staged['organizationId'] and failed['documentId'] == staged['documentId']
            and failed['version'] == 2 and failed['versionId'] == staged['versionId'] and failed['originalSha256'] == staged['originalSha256'], 'm7c-redis-restoration-version-binding')
    else:
        staged = read(state, 'fault-storage-outage-receipt.json', 8192)['staged']
        l.require(all(failed[key] == staged[key] for key in ['organizationId', 'documentId', 'versionId', 'originalSha256']),
            'm7c-s3-outage-restoration-version-binding')
    if state['scenario'] == 'CLEANUP_V1':
        l.require(failed['scheduledAt'] == staged['scheduledAt'], 'm7c-s3-outage-cleanup-schedule-binding')
    record(state, 'fault-restore-intent.json', {'at': stamp(), ('pendingProofSha256' if state['scenario'] == 'REDIS_V1' else 'failedProofSha256'): failed_sha})
    result = restore_owned(state)
    l.watchdog_admission(state)
    l.require(all(result.values()), 'm7c-s3-outage-operator-restore-incomplete')
    record(state, 'fault-restore-receipt.json', {'at': stamp(), ('pendingProofSha256' if state['scenario'] == 'REDIS_V1' else 'failedProofSha256'): failed_sha,
        'worker': state['processes']['workers'], 'rustfs': state['resources']['rustfs'],
        **({'redis': state['resources']['redis']} if state['scenario'] == 'REDIS_V1' else {}), **result})


class Arguments(argparse.ArgumentParser):
    def error(self, _message):
        raise l.GuardError('m7c-s3-outage-fault-arguments')


def main():
    l.require(not STATIC_DRAFT_ONLY and not l.STATIC_DRAFT_ONLY, 'm7c-s3-outage-fault-draft-review-required')
    parser = Arguments(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--scenario', required=True, choices=sorted(l.SCENARIOS))
    parser.add_argument('--mode', required=True, choices=['watchdog', 'pause-worker', 'storage-outage', 'redis-outage', 'queue-observation', 'restore', 'abort-incomplete'])
    parser.add_argument('--file-selected', action='store_true')
    parser.add_argument('--fixture-ready', action='store_true')
    parser.add_argument('--transfer-ready', action='store_true')
    args = parser.parse_args()
    l.require(args.mode not in {'redis-outage', 'queue-observation'} or args.scenario == 'REDIS_V1', 'm7c-redis-mode-scenario')
    l.require(args.mode != 'storage-outage' or args.scenario in {'INGESTION_V1', 'CLEANUP_V1'}, 'm7c-s3-mode-scenario')
    expected_file = args.mode == 'pause-worker' and args.scenario == 'INGESTION_V1'
    expected_fixture = args.mode == 'pause-worker' and args.scenario == 'CLEANUP_V1'
    expected_transfer = args.mode == 'pause-worker' and args.scenario == 'REDIS_V1'
    l.require(args.file_selected is expected_file and args.fixture_ready is expected_fixture and args.transfer_ready is expected_transfer, 'm7c-s3-outage-fault-selection-arguments')
    state = l.load(args.run, args.scenario)
    l.require(state['phase'] == 'READY', 'm7c-s3-outage-fault-ready-required')
    if args.mode != 'abort-incomplete':
        require_clean_evidence(state)
    if args.mode == 'queue-observation':
        result = queue_observation(state, 'observe')
        print(json.dumps({**l.receipt_scope(state), 'completed': True, 'queue': result}))
        return
    if args.mode == 'watchdog':
        watchdog(state)
    else:
        with l.lifecycle_lock(state['scenario']):
            if args.mode == 'abort-incomplete':
                abort_incomplete(state)
            elif args.mode == 'pause-worker':
                pause_worker(state, args.file_selected or args.fixture_ready or args.transfer_ready)
            elif args.mode == 'redis-outage':
                try:
                    redis_outage(state)
                except BaseException:
                    abort_incomplete(state)
                    raise
            elif args.mode == 'storage-outage':
                try:
                    storage_outage(state)
                except BaseException:
                    if state['scenario'] == 'CLEANUP_V1':
                        abort_incomplete(state)
                    raise
            else:
                restore(state)
    print(json.dumps({**l.receipt_scope(state), 'completed': True, 'operation': args.mode, 'runId': state['runId'], 'formalOutcome': ('INCOMPLETE' if args.mode == 'abort-incomplete' else 'NOT_DETERMINED')}))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        code = str(error) if isinstance(error, l.GuardError) and re.fullmatch('[a-z0-9-]{1,100}', str(error)) else 'm7c-s3-outage-fault-sanitized-failure'
        print(json.dumps({'completed': False, 'diagnostic': code, 'formalOutcome': 'INCOMPLETE'}), file=sys.stderr)
        sys.exit(1)
