"""Explicit quality-only fault admission. Import performs no process/resource/DB inspection."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

STATIC_DRAFT_ONLY = False
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
QUALITY = ROOT / 'tests/acceptance/quality'
NAMESPACE = 'vectorix-m7c-quality'
FAULT_FILES = ('fault_admission.py', 'fault_driver.py')


class FaultRefused(Exception):
    """Finite local diagnostics only; never include an underlying exception or private state."""


def need(condition, code):
    if not condition:
        raise FaultRefused(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def quality_module():
    """Load the existing exact tracked primitives only after this adapter's independent gate."""
    need(not STATIC_DRAFT_ONLY, 'FAULT_DISABLED')
    sys.path.insert(0, str(QUALITY))
    spec = importlib.util.spec_from_file_location('vectorix_fault_quality', QUALITY / 'quality-topology.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fault_sources():
    result = {}
    for name in FAULT_FILES:
        source = HERE / name
        info = source.lstat()
        need(source.is_file() and not source.is_symlink() and info.st_uid == os.getuid()
            and info.st_size <= 64 * 1024, 'FAULT_SOURCE')
        result[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    return result


def fault_directory(q, run_id):
    q.state_path(run_id)  # Reuse the exact quality run-ID rule, without a restore/load alias.
    return q.CACHE / ('m7c-interruption-' + run_id)


def binding(state):
    """Bind immutable infrastructure/build/source identities; do not serialize environment secrets."""
    return digest({key: state[key] for key in [
        'namespace', 'runId', 'prefix', 'applicationDatabase', 'vectorDatabase', 'commit',
        'lockfileSha256', 'prismaConfigSha256', 'migrations', 'acceptanceSources', 'builds',
        'images', 'resourceLimits', 'resources', 'modelVolume', 'apiOrigin', 'webOrigin',
    ]})


def validate_enrollment(state, enrollment):
    need(type(enrollment) is dict and set(enrollment) == {
        'schemaVersion', 'kind', 'runId', 'namespace', 'enrolledAt', 'bindingSha256',
        'sources', 'scope', 'enrollmentEmptyContentObserved',
    }, 'FAULT_ENROLLMENT_SHAPE')
    need(enrollment['schemaVersion'] == 1 and enrollment['kind'] == 'FRESH_BOUNDARY_FAULT'
        and enrollment['runId'] == state['runId'] and enrollment['namespace'] == NAMESPACE
        and enrollment['scope'] == 'ONE_DOCUMENT_ONE_COLLECTION_SEMANTIC_REBUILD'
        and enrollment['enrollmentEmptyContentObserved'] is True
        and type(enrollment['enrolledAt']) is int and enrollment['enrolledAt'] > 0
        and enrollment['bindingSha256'] == binding(state)
        and enrollment['sources'] == fault_sources(), 'FAULT_ENROLLMENT_BINDING')


def read_context(run_id):
    """Read only a newly enrolled future quality run; cleaned/archived capture phases are refused."""
    q = quality_module()
    state = q.read_state(run_id)
    q.validate_state(state, run_id, complete=True)
    need(state['phase'] == 'READY_FOR_QUALITY_IMPORT' and state.get('collectorProcess') is None,
        'FAULT_FRESH_QUALITY_PHASE')
    directory = fault_directory(q, run_id)
    q.private_directory(directory)
    enrollment = json.loads(q.read_private_bytes(directory / 'enrollment.json', 8192))
    validate_enrollment(state, enrollment)
    return q, state, enrollment, directory


def enroll(run_id):
    """One-time enrollment after synthetic account bootstrap, before any document or collection."""
    q = quality_module()
    with q.state_lock():
        state = q.read_state(run_id)
        need(state['phase'] == 'READY_FOR_QUALITY_IMPORT' and state.get('collectorProcess') is None,
            'FAULT_FRESH_QUALITY_PHASE')
        q.guard(state, 'dashboard')  # Existing guard remains unchanged and still requires a live worker.
        counts = q.db_query(state, '''SELECT json_build_object(
            'documents', (SELECT count(*) FROM public."Document"),
            'collections', (SELECT count(*) FROM public."Collection"))''')
        need(counts == {'documents': 0, 'collections': 0}, 'FAULT_ENROLL_BEFORE_CONTENT')
        directory = fault_directory(q, run_id)
        need(not directory.exists(), 'FAULT_ENROLLMENT_EXISTS')
        directory.mkdir(mode=0o700)
        q.private_directory(directory)
        enrollment = {'schemaVersion': 1, 'kind': 'FRESH_BOUNDARY_FAULT', 'runId': run_id,
            'namespace': NAMESPACE, 'enrolledAt': time.time_ns(), 'bindingSha256': binding(state),
            'sources': fault_sources(), 'scope': 'ONE_DOCUMENT_ONE_COLLECTION_SEMANTIC_REBUILD',
            'enrollmentEmptyContentObserved': True}
        q.save_json(directory / 'enrollment.json', enrollment)
        return {'enrolled': True, 'runId': run_id, 'faultScenarioAcceptance': 'NOT_RUN'}


def admission(q, state, enrollment, old_worker, *, absent):
    """A separate read-only capability; it never grants content access or changes the quality guard."""
    q.validate_state(state, state['runId'], complete=True)
    validate_enrollment(state, enrollment)
    need(state['phase'] == 'READY_FOR_QUALITY_IMPORT' and state.get('collectorProcess') is None,
        'FAULT_FRESH_QUALITY_PHASE')
    q.verify_pins(state)
    for service in q.SERVICES:
        resource = q.owned(state, service, running=True)
        need(resource['State'].get('Paused') is False, 'FAULT_NO_PAUSED_DEPENDENCY')
    q.verify_schema(state)
    need(state['processes'].get('workers') == old_worker, 'FAULT_ORIGINAL_WORKER_BINDING')
    need(q.process_alive(state, state['processes']['api']), 'FAULT_API_REQUIRED')
    worker_alive = q.process_alive(state, old_worker)
    need(worker_alive is (not absent), 'FAULT_WORKER_ABSENCE' if absent else 'FAULT_WORKER_REQUIRED')
    for saved in state['dashboardProcesses'].values():
        need(q.process_alive(state, saved), 'FAULT_DASHBOARD_IDENTITY')
    fixture = json.loads(q.read_private_bytes(q.state_path(state['runId']).parent / 'fixture.json', 128 * 1024))
    q.validate_fixture(fixture, state)
    return {'schemaVersion': 1, 'runId': state['runId'], 'namespace': NAMESPACE,
        'capability': 'WORKER_ABSENT_READ_ONLY' if absent else 'PRE_FAULT_READ_ONLY',
        'workerAbsent': absent, 'contentAuthorization': 'NORMAL_SESSION_REQUIRED'}


def admit_absent(run_id):
    """Require a completed owned crash/unpause record before admitting observation of an absent worker."""
    q, state, enrollment, directory = read_context(run_id)
    record = json.loads(q.read_private_bytes(directory / 'fault-result.json', 32768))
    need(record.get('schemaVersion') == 1 and record.get('runId') == run_id
        and record.get('bindingSha256') == enrollment['bindingSha256']
        and record.get('status') == 'WORKER_KILLED_MODEL_RESUMED'
        and record.get('killed') is True and record.get('modelResumed') is True
        and record.get('recoveryAcceptance') == 'NOT_OBSERVED'
        and type(record.get('trialDeadlineMonotonicNs')) is int
        and time.monotonic_ns() <= record['trialDeadlineMonotonicNs'], 'FAULT_COMPLETED_ACTION_REQUIRED')
    proof = admission(q, state, enrollment, record['oldWorker'], absent=True)
    need(time.monotonic_ns() <= record['trialDeadlineMonotonicNs'], 'FAULT_TRIAL_DEADLINE')
    return proof


def observe_boundary(q, state, scope):
    """Fixed SELECT of one synthetic candidate/claim. No task/token/vector payload is written or exposed."""
    need(type(scope) is dict and set(scope) == {'organizationId', 'collectionId', 'generationId', 'documentId'}
        and all(type(value) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value)
            for value in scope.values()), 'FAULT_SCOPE')
    fixture = json.loads(q.read_private_bytes(q.state_path(state['runId']).parent / 'fixture.json', 128 * 1024))
    q.validate_fixture(fixture, state)
    need(scope['organizationId'] == fixture['users']['owner']['organizationId'], 'FAULT_OWNER_ORGANIZATION')
    organization, collection, generation, document = [scope[key] for key in
        ['organizationId', 'collectionId', 'generationId', 'documentId']]
    # Values are restricted above to a quote-free ASCII alphabet. Prisma cannot serve this external read-only probe.
    query = f'''SELECT json_build_object('databaseNow', clock_timestamp(),
      'documents',(SELECT count(*) FROM public."Document"),
      'collections',(SELECT count(*) FROM public."Collection"),
      'rows', COALESCE((SELECT json_agg(row_to_json(s)) FROM (
        SELECT c."activeGenerationId", a.status AS "activeStatus", g.id AS "generationId",
          g.status AS "generationStatus", g."previousGenerationId", g."configurationRevision", g."chunkerVersion",
          g."modelIdentity", g."capabilitySnapshot"->>'provider' AS provider,
          g."capabilitySnapshot"->>'dimensions' AS dimensions,
          p."indexedDocumentId", p."sourceHash", p."profileHash",
          d."sourceVersionId", d."extractionId", d."extractorVersion", d."buildRevision", d."metadataRevision",
          p."unitManifestHash", p."unitCount", p."completedUnits", p."boundaryScores",
          p.state AS "planState", encode(p."lastUnitVector",'hex') AS "checkpointHex",
          t.id AS "taskId", t.status AS "taskStatus", t.stage, t."leaseEpoch"::text,
          t."leasedUntil", t."leasedUntil" > clock_timestamp() AS "claimLive", t."attempts", t."continuations",
          (SELECT json_agg(row_to_json(w)) FROM (SELECT id, state, "leaseEpoch"::text,
             "taskId", "deadlineAt", "dispatchStartedAt", "deadlineAt" > clock_timestamp() AS "deadlineLive"
           FROM public."EmbeddingWorkAttempt" WHERE "indexedDocumentId" = p."indexedDocumentId"
             AND "organizationId" = '{organization}' AND purpose = 'BOUNDARY'
             AND state = 'IN_FLIGHT' LIMIT 3) w) AS "inFlight"
        FROM public."Collection" c
        JOIN public."IndexGeneration" a ON a.id = c."activeGenerationId" AND a."organizationId"=c."organizationId"
        JOIN public."IndexGeneration" g ON g."collectionId"=c.id AND g."organizationId"=c."organizationId"
        JOIN public."IndexedDocument" d ON d."generationId"=g.id AND d."organizationId"=g."organizationId"
        JOIN public."SemanticChunkPlan" p ON p."indexedDocumentId"=d.id AND p."organizationId"=d."organizationId"
        JOIN public."IndexTask" t ON t."indexedDocumentId"=d.id AND t."organizationId"=d."organizationId"
        WHERE c.id='{collection}' AND c."organizationId"='{organization}' AND g.id='{generation}'
          AND d."documentId"='{document}' AND t.kind='INDEX_DOCUMENT' LIMIT 3
      ) s), '[]'::json))'''
    value = q.db_query(state, query)
    need(value.get('documents') == 1 and value.get('collections') == 1 and len(value.get('rows', [])) == 1,
        'FAULT_ONE_DOCUMENT_ONE_COLLECTION')
    row = value['rows'][0]
    need(row['activeStatus'] == 'ACTIVE' and row['generationStatus'] == 'BUILDING'
        and row['previousGenerationId'] == row['activeGenerationId']
        and row['generationId'] == generation and row['chunkerVersion'] == 'semantic-utf8-v1'
        and row['provider'] == 'OLLAMA' and type(row['dimensions']) is str
        and re.fullmatch(r'[1-9][0-9]{0,3}', row['dimensions'])
        and int(row['dimensions']) <= 3072
        and row['planState'] == 'PLANNING'
        and type(row['unitCount']) is int and 65 <= row['unitCount'] <= 256
        and type(row['completedUnits']) is int and 1 <= row['completedUnits'] < row['unitCount']
        and type(row['boundaryScores']) is list and len(row['boundaryScores']) == row['completedUnits'] - 1
        and all(type(score) is int and 0 <= score <= 2000000 for score in row['boundaryScores'])
        and isinstance(row['checkpointHex'], str) and len(row['checkpointHex']) == int(row['dimensions']) * 8
        and re.fullmatch(r'[a-f0-9]+', row['checkpointHex']),
        'FAULT_ACCEPTED_PARTIAL_PREFIX_REQUIRED')
    row['acceptedScoresSha256'] = digest(row['boundaryScores'])
    row['lastVectorSha256'] = hashlib.sha256(bytes.fromhex(row.pop('checkpointHex'))).hexdigest()
    row['databaseNow'] = value['databaseNow']
    return row
