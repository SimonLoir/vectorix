"""Explicit one-shot, read-only interruption observer; imports perform no resource I/O."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import time

from recovery_observation import (ObservationRefused, STAGES, assess, bounded_snapshot,
    canonical, need, sha, snapshot_sql, validate_scope)

STATIC_DRAFT_ONLY = False
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
FAULT = HERE.parent / 'fault'
RUNTIME_FILES = ('recovery_observation.py', 'recovery_observer.py')
FAULT_FILES = ('fault_admission.py', 'fault_driver.py')


class ClosedParser(argparse.ArgumentParser):
    def error(self, _message):
        raise ObservationRefused('OBSERVER_ARGUMENTS')


def local_bytes(path, maximum):
    """Read only an exact local owned regular source/manifest; never follow a parent or leaf symlink."""
    need(path.parent.resolve() == path.parent, 'OBSERVER_SOURCE_PATH')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_size <= maximum,
            'OBSERVER_SOURCE_FILE')
        value = os.read(descriptor, maximum + 1)
        need(len(value) <= maximum, 'OBSERVER_SOURCE_FILE')
        return value
    finally:
        os.close(descriptor)


def verify_sources():
    """Require the separately frozen manifest before importing the independently verified fault adapter."""
    manifest_bytes = local_bytes(HERE / 'observer-manifest.json', 16384)
    manifest = json.loads(manifest_bytes)
    need(set(manifest) == {'schemaVersion', 'status', 'runtimeSha256', 'faultSha256'}
        and manifest['schemaVersion'] == 1 and manifest['status'] == 'FROZEN_OFFLINE_NATIVE_NOT_RUN'
        and set(manifest['runtimeSha256']) == set(RUNTIME_FILES)
        and set(manifest['faultSha256']) == set(FAULT_FILES), 'OBSERVER_MANIFEST')
    for names, directory, expected in [(RUNTIME_FILES, HERE, manifest['runtimeSha256']),
        (FAULT_FILES, FAULT, manifest['faultSha256'])]:
        need(all(sha(local_bytes(directory / name, 128 * 1024)) == expected[name] for name in names), 'OBSERVER_SOURCE_DRIFT')
    return sha(manifest_bytes)


def fault_module():
    """No flag is overridden: the independently reviewed fault admission must also be enabled."""
    sys.path.insert(0, str(FAULT))
    spec = importlib.util.spec_from_file_location('vectorix_recovery_fault_admission', FAULT / 'fault_admission.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def proof_binding(proof, run_id, scope, manifest_sha, fault_sha, stage):
    need(type(proof) is dict and proof.get('schemaVersion') == 1 and proof.get('runId') == run_id
        and proof.get('scope') == scope and proof.get('manifestSha256') == manifest_sha
        and proof.get('faultResultSha256') == fault_sha and proof.get('stage') == stage
        and proof.get('status') == 'CATALOG_CHECKPOINT_RECORDED'
        and proof.get('snapshotSha256') == sha(canonical(proof.get('snapshot'))), 'OBSERVER_PRIOR_PROOF')
    return proof


def observe(run_id, stage, scope):
    """Write new exclusive local evidence only; all business/catalog access is guarded SELECT.

    A STARTED file is persisted before observation and is never removed/replayed.
    Successful evidence is an application-catalog checkpoint, not browser/native
    wire/physical-vector acceptance. A failed assessment retains a finite diagnostic.
    """
    need(not STATIC_DRAFT_ONLY, 'OBSERVER_DISABLED')
    validate_scope(scope)
    need(stage in STAGES, 'OBSERVER_STAGE')
    manifest_sha = verify_sources()
    fault = fault_module()
    q, state, enrollment, fault_directory = fault.read_context(run_id)
    fault_bytes = q.read_private_bytes(fault_directory / 'fault-result.json', 32768)
    action = json.loads(fault_bytes)
    need(action.get('runId') == run_id and action.get('bindingSha256') == enrollment['bindingSha256']
        and action.get('status') == 'WORKER_KILLED_MODEL_RESUMED'
        and action.get('oldWorker') is not None and action.get('caught') is not None
        and action['caught'].get('activeGenerationId') == scope['oldGenerationId'], 'OBSERVER_FAULT_BINDING')
    deadline = action.get('trialDeadlineMonotonicNs')
    need(type(deadline) is int and time.monotonic_ns() <= deadline, 'OBSERVER_TRIAL_DEADLINE')
    fixture = json.loads(q.read_private_bytes(q.state_path(run_id).parent / 'fixture.json', 128 * 1024))
    q.validate_fixture(fixture, state)
    need(scope['organizationId'] == fixture['users']['owner']['organizationId'], 'OBSERVER_OWNER_ORGANIZATION')
    directory = q.CACHE / ('m7c-interruption-observer-' + run_id)
    if not directory.exists():
        directory.mkdir(mode=0o700)
    q.private_directory(directory)
    invocation_path, proof_path = directory / (stage + '-invocation.json'), directory / (stage + '.json')
    need(not invocation_path.exists() and not proof_path.exists(), 'OBSERVER_NO_REPLAY')
    fault_sha = sha(fault_bytes)
    common = {'schemaVersion': 1, 'runId': run_id, 'stage': stage, 'scope': scope,
        'manifestSha256': manifest_sha, 'faultResultSha256': fault_sha}
    q.save_json(invocation_path, {**common, 'status': 'STARTED', 'startedAtEpochNs': time.time_ns()}, exclusive=True)
    snapshot = None
    validated = False
    try:
        def guard():
            need(time.monotonic_ns() <= deadline, 'OBSERVER_TRIAL_DEADLINE')
            if stage != 'recovered':
                fault.admit_absent(run_id)
            else:
                fresh = q.read_state(run_id)
                fault.validate_enrollment(fresh, enrollment)
                q.guard(fresh, 'dashboard')
                need(fresh['processes']['workers'] != action['oldWorker']
                    and not q.process_alive(fresh, action['oldWorker']), 'OBSERVER_NEW_WORKER_REQUIRED')
            need(time.monotonic_ns() <= deadline, 'OBSERVER_TRIAL_DEADLINE')
        guard()
        prior = expired = None
        if stage != 'absent-checkpoint':
            prior = proof_binding(json.loads(q.read_private_bytes(directory / 'absent-checkpoint.json', 2 * 1024**2)),
                run_id, scope, manifest_sha, fault_sha, 'absent-checkpoint')
        if stage == 'recovered':
            expired = proof_binding(json.loads(q.read_private_bytes(directory / 'expired-before-restart.json', 2 * 1024**2)),
                run_id, scope, manifest_sha, fault_sha, 'expired-before-restart')
        snapshot = q.db_query(state, snapshot_sql(scope))
        bounded_snapshot(snapshot, scope)
        validated = True
        result = assess(stage, snapshot, scope, action, prior, expired)
        guard()
        proof = {**common, 'status': 'CATALOG_CHECKPOINT_RECORDED', 'observedAtEpochNs': time.time_ns(),
            'snapshotSha256': sha(canonical(snapshot)), 'snapshot': snapshot, 'assessment': result,
            'recoveryAcceptance': 'CATALOG_ONLY_BROWSER_AND_PHYSICAL_PENDING'}
    except BaseException as error:
        proof = {**common, 'status': 'INCOMPLETE', 'diagnostic': safe_diagnostic(error),
            'recoveryAcceptance': 'NOT_ESTABLISHED'}
        if validated:
            proof.update(snapshot=snapshot, snapshotSha256=sha(canonical(snapshot)))
        q.save_json(proof_path, proof, exclusive=True)
        raise ObservationRefused(proof['diagnostic']) from None
    q.save_json(proof_path, proof, exclusive=True)
    return {'runId': run_id, 'stage': stage, 'status': proof['status'],
        'canonicalProofSha256': sha(canonical(proof)), 'acceptedPrefixUnits': result['acceptedPrefixUnits'],
        'abandonedWorkState': result['abandonedWorkState'], 'recoveryAcceptance': proof['recoveryAcceptance']}


def main(argv=None):
    need(not STATIC_DRAFT_ONLY, 'OBSERVER_DISABLED')
    parser = ClosedParser(add_help=False)
    parser.add_argument('--run', required=True)
    parser.add_argument('--stage', choices=STAGES, required=True)
    for name in ['organization', 'collection', 'old-generation', 'generation', 'document']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    return observe(args.run, args.stage, {'organizationId': args.organization, 'collectionId': args.collection,
        'oldGenerationId': args.old_generation, 'generationId': args.generation, 'documentId': args.document})


SAFE_DIAGNOSTICS = frozenset('''OBSERVER_DISABLED OBSERVER_ARGUMENTS OBSERVER_SCOPE OBSERVER_STAGE OBSERVER_SOURCE_PATH
OBSERVER_SOURCE_FILE OBSERVER_MANIFEST OBSERVER_SOURCE_DRIFT OBSERVER_PRIOR_PROOF OBSERVER_FAULT_BINDING OBSERVER_TRIAL_DEADLINE
OBSERVER_OWNER_ORGANIZATION OBSERVER_NO_REPLAY OBSERVER_NEW_WORKER_REQUIRED OBSERVER_INTEGER OBSERVER_DECIMAL OBSERVER_TIMESTAMP
OBSERVER_ONE_DOCUMENT_ONE_COLLECTION OBSERVER_ROW_BOUND OBSERVER_ORGANIZATION OBSERVER_GENERATIONS OBSERVER_DOCUMENT
OBSERVER_PLAN_BOUNDS OBSERVER_UNIT_RANGES OBSERVER_SCORES OBSERVER_CHECKPOINT OBSERVER_WORK_SCOPE OBSERVER_SNAPSHOT_BYTES
OBSERVER_DUPLICATE_ROWS OBSERVER_CHUNK_LAYOUT OBSERVER_PARENT_CONTAINMENT OBSERVER_CHILD_ORDINALS OBSERVER_CHILD_MANIFEST
OBSERVER_SOURCE_HOLD OBSERVER_EMBEDDING_ACCOUNTING OBSERVER_BILLED_USAGE_UNKNOWN OBSERVER_PLAN OBSERVER_TASK
OBSERVER_PREFIX_CHANGED OBSERVER_ABANDONED_WORK OBSERVER_ABSENT_STATE OBSERVER_PRIOR_CHECKPOINT
OBSERVER_NATURAL_DEADLINE_NOT_PASSED OBSERVER_EXPIRED_CHECKPOINT_REQUIRED OBSERVER_RECOVERY_NOT_COMPLETE
OBSERVER_RECOVERY_GENERATIONS OBSERVER_PUBLICATION OBSERVER_FINAL_LAYOUT OBSERVER_HISTORY_CHANGED
OBSERVER_ACCEPTED_PREFIX_REDISPATCHED OBSERVER_ABANDONED_OUTCOME_NOT_UNCERTAIN OBSERVER_RESERVATIONS_REMAIN
OBSERVER_CHILD_ACCOUNTING OBSERVER_TASK_COUNTERS_REWOUND OBSERVER_CANDIDATE_BINDING OBSERVER_SQL_BOUND
OBSERVER_CHECKPOINT_CHANGED OBSERVER_DEADLINES_CHANGED OBSERVER_TIMESTAMP_PROVENANCE'''.split())


def safe_diagnostic(error):
    return str(error) if isinstance(error, ObservationRefused) and str(error) in SAFE_DIAGNOSTICS else 'OBSERVER_INCOMPLETE'


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except BaseException as error:
        print(json.dumps({'status': 'REFUSED_OR_INCOMPLETE', 'diagnostic': safe_diagnostic(error),
            'recoveryAcceptance': 'NOT_ESTABLISHED'}))
        sys.exit(1)
