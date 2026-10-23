"""Pure bounded application-catalog observation for one interrupted semantic rebuild.

No import or function here opens a database, process, provider or file. SQL values
are limited to a quote-free identifier alphabet because the existing external
quality reader accepts a fixed SQL statement rather than a parameter array.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal

STAGES = ('absent-checkpoint', 'expired-before-restart', 'recovered')
LIMITS = {'generations': 2, 'publications': 4, 'plans': 4, 'documents': 2,
    'tasks': 24, 'work': 128, 'chunks': 640, 'holds': 4}
IMMUTABLE_PLAN = ('indexedDocumentId', 'generationId', 'configurationRevision', 'chunkerVersion',
    'unitizerVersion', 'sourceHash', 'profileHash', 'modelIdentity', 'unitManifestHash', 'unitCount', 'unitRanges')
IMMUTABLE_WORK = ('id', 'generationId', 'indexedDocumentId', 'purpose', 'operationKey', 'batchOrdinal',
    'attemptNumber', 'inputHash', 'inputCount', 'preparedInputBytes', 'taskId', 'leaseEpoch', 'createdAt', 'deadlineAt')
DECIMAL_FIELDS = ('reservedPreparedBytes', 'reservedBatches', 'dispatchedPreparedBytes', 'dispatchedBatches')
PRISMA_TIMESTAMP_TYPES = {key: 'timestamp without time zone' for key in
    ['taskLease', 'workDeadline', 'workUncertain', 'holdRetention']}
UTC_SESSIONS = {'UTC', 'Etc/UTC'}


class ObservationRefused(Exception):
    """Finite diagnostic, without an underlying SQL/configuration exception."""


def need(condition, code):
    if not condition:
        raise ObservationRefused(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def integer(value, maximum=2**63 - 1):
    need(type(value) is int and 0 <= value <= maximum, 'OBSERVER_INTEGER')
    return value


def decimal(value):
    need(type(value) is str and re.fullmatch(r'0|[1-9][0-9]{0,18}', value), 'OBSERVER_DECIMAL')
    return integer(int(value))


def instant(value, *, prisma_utc_session=None):
    """Parse an instant without altering its recorded string.

    PostgreSQL emits the approved Prisma DateTime columns without an offset.
    Only explicitly designated schema fields may attach UTC, and only after the
    snapshot proves both their actual SQL type and a UTC reader session. Clock
    observations and arbitrary strings still require an explicit offset.
    """
    need(type(value) is str and len(value) <= 40 and re.fullmatch(
        r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})?', value),
        'OBSERVER_TIMESTAMP')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (ValueError, TypeError):
        raise ObservationRefused('OBSERVER_TIMESTAMP') from None
    if result.tzinfo is None:
        need(prisma_utc_session in UTC_SESSIONS, 'OBSERVER_TIMESTAMP')
        result = result.replace(tzinfo=timezone.utc)
    return result


def validate_scope(value):
    need(type(value) is dict and set(value) == {'organizationId', 'collectionId', 'oldGenerationId',
        'generationId', 'documentId'} and all(type(item) is str
        and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', item) for item in value.values()), 'OBSERVER_SCOPE')
    need(value['oldGenerationId'] != value['generationId'], 'OBSERVER_SCOPE')
    return value


def snapshot_sql(scope):
    """One statement gives one consistent MVCC snapshot; every array has count+overflow sentinel.

    Explicit column projections deliberately exclude source text, capability JSON,
    lease tokens, credentials, endpoints and the raw float32 checkpoint. The only
    checkpoint value crossing the SQL boundary is PostgreSQL's built-in SHA-256 digest, comparable to the fault action's
    SHA-256 over the exact stored little-endian float32 bytes.
    """
    validate_scope(scope)
    org, col, old, new, doc = (scope[k] for k in ['organizationId', 'collectionId',
        'oldGenerationId', 'generationId', 'documentId'])
    # Only this closed statement is executable, after the separate ownership guard.
    sql = f'''SELECT observation FROM (WITH
    gens AS (SELECT g.id,g."organizationId",g."collectionId",g.status,g."previousGenerationId",
      g."configurationRevision",g."chunkerVersion",g."parentContextVersion",g."modelIdentity",
      g."createdAt",g."activatedAt",g."retiredAt",g."cleanupAfter"
      FROM public."IndexGeneration" g WHERE g."organizationId"='{org}' AND g."collectionId"='{col}'),
    pubs AS (SELECT p.id,p."organizationId",p."generationId",p."documentId",p."sourceVersionId",p."extractionId",
      p."extractorVersion",p."buildRevision",p."metadataRevision",p.status,p."chunkCount",p."materializedChunks",
      p."manifestHash",p."vectorSealedAt",p."publishedAt",p."retiredAt",v.sha256 AS "originalSha256",
      v."contentState",v.status AS "sourceStatus",v."discardedAt"
      FROM public."IndexedDocument" p JOIN public."DocumentVersion" v ON v.id=p."sourceVersionId"
        AND v."organizationId"=p."organizationId" AND v."documentId"=p."documentId"
      WHERE p."organizationId"='{org}' AND p."collectionId"='{col}'),
    plans AS (SELECT p."indexedDocumentId",p."organizationId",p."generationId",p."configurationRevision",
      p."chunkerVersion",p."unitizerVersion",p."sourceHash",p."profileHash",p."modelIdentity",p."unitManifestHash",
      p."unitCount",CASE WHEN jsonb_typeof(p."unitRanges")='array' THEN
        CASE WHEN jsonb_array_length(p."unitRanges")<=256 THEN p."unitRanges" END END AS "unitRanges",
      p."completedUnits",CASE WHEN jsonb_typeof(p."boundaryScores")='array' THEN
        CASE WHEN jsonb_array_length(p."boundaryScores")<=255 THEN p."boundaryScores" END END AS "boundaryScores",
      p.state,p."thresholdDistance",CASE WHEN jsonb_typeof(p."finalRanges")='array' THEN
        CASE WHEN jsonb_array_length(p."finalRanges")<=512 THEN p."finalRanges" END END AS "finalRanges",
      p."planHash",p."reservedBytes"::text,p."storedBytes"::text,p."reservedPreparedBytes"::text,
      p."reservedBatches"::text,p.revision::text,p."sealedAt",p."cleanedAt",
      CASE WHEN p."lastUnitVector" IS NULL THEN NULL ELSE encode(sha256(p."lastUnitVector"),'hex') END AS "checkpointSha256",
      octet_length(p."lastUnitVector") AS "checkpointBytes"
      FROM public."SemanticChunkPlan" p JOIN pubs d ON d.id=p."indexedDocumentId" AND d."organizationId"=p."organizationId"),
    tasks AS (SELECT t.id,t."organizationId",t."generationId",t."indexedDocumentId",t.kind,t.status,t.stage,
      t."requestedBy",t."availableAt",t.attempts,t.continuations,t."continuationPending",t."leaseEpoch"::text,
      t."leasedUntil",t."reservedChunks",t."completedChunks",t."createdAt",t."completedAt"
      FROM public."IndexTask" t WHERE t."organizationId"='{org}' AND t."collectionId"='{col}'),
    work AS (SELECT w.id,w."organizationId",w."generationId",w."indexedDocumentId",w.purpose,w."operationKey",
      w."batchOrdinal",w."attemptNumber",w."inputHash",w."inputCount",w."preparedInputBytes",w."taskId",
      w."leaseEpoch"::text,w.state,w."reservedPreparedBytes"::text,w."reservedBatches"::text,
      w."dispatchedPreparedBytes"::text,w."dispatchedBatches"::text,w."successfulRequests",
      w."estimatedInputTokens"::text,w."providerInputTokens"::text,w."billedInputTokens"::text,
      w."createdAt",w."dispatchStartedAt",w."deadlineAt",w."settledAt",w."usageRecordedAt",w."uncertainAt"
      FROM public."EmbeddingWorkAttempt" w JOIN pubs p ON p.id=w."indexedDocumentId" AND p."organizationId"=w."organizationId"),
    chunks AS (SELECT c.id,c."organizationId",c."generationId",c."indexedDocumentId",c.ordinal,c.kind,c."parentId",
      c."startOffset",c."endOffset",c."textHash",c."embeddingInputHash",octet_length(c.text) AS "textBytes"
      FROM public."Chunk" c JOIN pubs p ON p.id=c."indexedDocumentId" AND p."organizationId"=c."organizationId"),
    documents AS (SELECT d."organizationId",d."generationId",d."documentId",d."desiredVersionId",d."desiredExtractionId",
      d."desiredMetadataRevision",d."buildRevision",d."targetChunkCount",d."publishedIndexedDocumentId",d."removedAt"
      FROM public."GenerationDocument" d WHERE d."organizationId"='{org}' AND d."collectionId"='{col}'),
    holds AS (SELECT h."indexedDocumentId",h."organizationId",h."versionId",h.state,h."retainUntil",h."releasedAt"
      FROM public."DocumentSourceHold" h JOIN pubs p ON p.id=h."indexedDocumentId" AND p."organizationId"=h."organizationId")
    SELECT json_build_object('databaseNow',statement_timestamp(),'sessionTimeZone',current_setting('TimeZone'),
      'prismaTimestampTypes',json_build_object(
        'taskLease',pg_typeof((SELECT "leasedUntil" FROM tasks LIMIT 1))::text,
        'workDeadline',pg_typeof((SELECT "deadlineAt" FROM work LIMIT 1))::text,
        'workUncertain',pg_typeof((SELECT "uncertainAt" FROM work LIMIT 1))::text,
        'holdRetention',pg_typeof((SELECT "retainUntil" FROM holds LIMIT 1))::text),
      'globalDocuments',(SELECT count(*) FROM public."Document"),
      'globalCollections',(SELECT count(*) FROM public."Collection"),
      'scopeDocument',(SELECT count(*) FROM public."Document" WHERE id='{doc}' AND "organizationId"='{org}' AND "deletedAt" IS NULL),
      'activeGenerationId',(SELECT "activeGenerationId" FROM public."Collection" WHERE id='{col}' AND "organizationId"='{org}' AND "deletedAt" IS NULL),
      'counts',json_build_object('generations',(SELECT count(*) FROM gens),'publications',(SELECT count(*) FROM pubs),
        'plans',(SELECT count(*) FROM plans),'documents',(SELECT count(*) FROM documents),'tasks',(SELECT count(*) FROM tasks),
        'work',(SELECT count(*) FROM work),'chunks',(SELECT count(*) FROM chunks),'holds',(SELECT count(*) FROM holds)),
      'generations',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM gens ORDER BY id LIMIT 3) x),'[]'::json),
      'publications',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM pubs ORDER BY id LIMIT 5) x),'[]'::json),
      'plans',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM plans ORDER BY "indexedDocumentId" LIMIT 5) x),'[]'::json),
      'documents',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM documents ORDER BY "generationId" LIMIT 3) x),'[]'::json),
      'tasks',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM tasks ORDER BY id LIMIT 25) x),'[]'::json),
      'work',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM work ORDER BY id LIMIT 129) x),'[]'::json),
      'chunks',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM chunks ORDER BY "indexedDocumentId",ordinal LIMIT 641) x),'[]'::json),
      'holds',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM holds ORDER BY "indexedDocumentId" LIMIT 5) x),'[]'::json),
      'indexAccounting',(SELECT json_build_object('activeChunks',"activeChunks"::text,'retainedChunks',"retainedChunks"::text,
        'reservedChunks',"reservedChunks"::text) FROM public."CollectionIndexAccounting" WHERE "organizationId"='{org}' AND "collectionId"='{col}'),
      'embeddingAccounting',(SELECT json_build_object('reservedPlanBytes',"reservedPlanBytes"::text,'storedPlanBytes',"storedPlanBytes"::text,
        'reservedPreparedBytes',"reservedPreparedBytes"::text,'reservedBatches',"reservedBatches"::text,
        'dispatchedPreparedBytes',"dispatchedPreparedBytes"::text,'dispatchedBatches',"dispatchedBatches"::text,
        'observedSuccessfulRequests',"observedSuccessfulRequests"::text,'observedEstimatedInputTokens',"observedEstimatedInputTokens"::text,
        'observedProviderInputTokens',"observedProviderInputTokens"::text,'observedBilledInputTokens',"observedBilledInputTokens"::text,
        'unknownProviderTokenBatches',"unknownProviderTokenBatches"::text,'unknownBilledTokenBatches',"unknownBilledTokenBatches"::text,
        'uncertainAttempts',"uncertainAttempts"::text) FROM public."OrganizationEmbeddingAccounting" WHERE "organizationId"='{org}')) AS observation) AS bounded_snapshot'''
    need(len(sql) <= 16384, 'OBSERVER_SQL_BOUND')
    return sql


def one(values, predicate, code):
    rows = [row for row in values if predicate(row)]
    need(len(rows) == 1, code)
    return rows[0]


def bounded_snapshot(snapshot, scope):
    """Validate focused cardinalities before traversing persisted semantic ranges or ledgers."""
    validate_scope(scope)
    need(type(snapshot) is dict and snapshot['globalDocuments'] == 1 and snapshot['globalCollections'] == 1
        and snapshot['scopeDocument'] == 1, 'OBSERVER_ONE_DOCUMENT_ONE_COLLECTION')
    instant(snapshot['databaseNow'])
    need(snapshot.get('sessionTimeZone') in UTC_SESSIONS
        and snapshot.get('prismaTimestampTypes') == PRISMA_TIMESTAMP_TYPES, 'OBSERVER_TIMESTAMP_PROVENANCE')
    for name, maximum in LIMITS.items():
        rows = snapshot[name]
        need(type(rows) is list and integer(snapshot['counts'][name], maximum) == len(rows), 'OBSERVER_ROW_BOUND')
        need(all(row['organizationId'] == scope['organizationId'] for row in rows), 'OBSERVER_ORGANIZATION')
    need({g['id'] for g in snapshot['generations']} == {scope['oldGenerationId'], scope['generationId']}, 'OBSERVER_GENERATIONS')
    need(all(p['documentId'] == scope['documentId'] for p in snapshot['publications']), 'OBSERVER_DOCUMENT')
    need(all(d['documentId'] == scope['documentId'] for d in snapshot['documents']), 'OBSERVER_DOCUMENT')
    for plan in snapshot['plans']:
        count = integer(plan['unitCount'], 256)
        need(1 <= count and type(plan['unitRanges']) is list and type(plan['boundaryScores']) is list
            and len(plan['unitRanges']) == count and len(plan['boundaryScores']) == max(0, plan['completedUnits'] - 1), 'OBSERVER_PLAN_BOUNDS')
        integer(plan['completedUnits'], count)
        previous = -1
        for ordinal, unit in enumerate(plan['unitRanges']):
            need(type(unit) is dict and set(unit) == {'ordinal', 'start', 'end'} and unit['ordinal'] == ordinal
                and type(unit['start']) is int and type(unit['end']) is int and previous <= unit['start'] < unit['end'] <= 25 * 1024**2,
                'OBSERVER_UNIT_RANGES')
            previous = unit['end']
        need(all(type(n) is int and 0 <= n <= 2000000 for n in plan['boundaryScores']), 'OBSERVER_SCORES')
        for key in ['reservedBytes', 'storedBytes', 'reservedPreparedBytes', 'reservedBatches', 'revision']:
            decimal(plan[key])
        need(plan['checkpointSha256'] is None or re.fullmatch('[a-f0-9]{64}', plan['checkpointSha256']), 'OBSERVER_CHECKPOINT')
        need(plan['checkpointBytes'] is None or integer(plan['checkpointBytes'], 12288) % 4 == 0, 'OBSERVER_CHECKPOINT')
    for work in snapshot['work']:
        need(work['generationId'] in {scope['oldGenerationId'], scope['generationId']}, 'OBSERVER_WORK_SCOPE')
        for key in DECIMAL_FIELDS + ('leaseEpoch',): decimal(work[key])
        integer(work['inputCount'], 64)
        integer(work['preparedInputBytes'], 1024**2)
        integer(work['attemptNumber'], 4096)
        integer(work['batchOrdinal'], 8192)
        instant(work['deadlineAt'], prisma_utc_session=snapshot['sessionTimeZone'])
    pubs = {p['id']: p for p in snapshot['publications']}
    chunks = {c['id']: c for c in snapshot['chunks']}
    need(len(pubs) == len(snapshot['publications']) and len(chunks) == len(snapshot['chunks']), 'OBSERVER_DUPLICATE_ROWS')
    for chunk in chunks.values():
        owner = pubs.get(chunk['indexedDocumentId'])
        need(owner is not None and chunk['generationId'] == owner['generationId']
            and chunk['kind'] in {'CHILD', 'PARENT'} and re.fullmatch('[a-f0-9]{64}', chunk['textHash'])
            and type(chunk['startOffset']) is int and type(chunk['endOffset']) is int
            and 0 <= chunk['startOffset'] < chunk['endOffset'] <= 25 * 1024**2
            and type(chunk['textBytes']) is int and 0 < chunk['textBytes'] <= 49152, 'OBSERVER_CHUNK_LAYOUT')
        if chunk['kind'] == 'PARENT':
            need(chunk['parentId'] is None and chunk['embeddingInputHash'] is None, 'OBSERVER_CHUNK_LAYOUT')
        else:
            need(type(chunk['embeddingInputHash']) is str and re.fullmatch('[a-f0-9]{64}', chunk['embeddingInputHash']),
                'OBSERVER_CHUNK_LAYOUT')
            if chunk['parentId'] is not None:
                parent = chunks.get(chunk['parentId'])
                need(parent is not None and parent['kind'] == 'PARENT' and parent['parentId'] is None
                    and parent['indexedDocumentId'] == chunk['indexedDocumentId'] and parent['generationId'] == chunk['generationId']
                    and parent['startOffset'] <= chunk['startOffset'] < chunk['endOffset'] <= parent['endOffset'], 'OBSERVER_PARENT_CONTAINMENT')
    for publication in pubs.values():
        children = sorted((c for c in chunks.values() if c['indexedDocumentId'] == publication['id']
            and c['kind'] == 'CHILD'), key=lambda c: c['ordinal'])
        need([c['ordinal'] for c in children] == list(range(len(children))), 'OBSERVER_CHILD_ORDINALS')
        if publication['vectorSealedAt'] is not None:
            manifest = sha(canonical([[c['id'], c['ordinal'], c['textHash']] for c in children]))
            need(children and manifest == publication['manifestHash']
                and len(children) == publication['chunkCount'] == publication['materializedChunks'], 'OBSERVER_CHILD_MANIFEST')
    for hold in snapshot['holds']:
        owner = pubs.get(hold['indexedDocumentId'])
        need(owner is not None and hold['versionId'] == owner['sourceVersionId'], 'OBSERVER_SOURCE_HOLD')
    need(len(canonical(snapshot)) <= 1024**2, 'OBSERVER_SNAPSHOT_BYTES')


def accounting(snapshot):
    """Reconcile this one-document fixture's complete A+B logical ledger, including uncertainty."""
    plans, work, actual = snapshot['plans'], snapshot['work'], snapshot['embeddingAccounting']
    need(type(actual) is dict, 'OBSERVER_EMBEDDING_ACCOUNTING')
    observed = [w for w in work if w['usageRecordedAt'] is not None]
    expected = {
        'reservedPlanBytes': sum(decimal(p['reservedBytes']) for p in plans),
        'storedPlanBytes': sum(decimal(p['storedBytes']) for p in plans),
        'reservedPreparedBytes': sum(decimal(p['reservedPreparedBytes']) for p in plans) + sum(decimal(w['reservedPreparedBytes']) for w in work),
        'reservedBatches': sum(decimal(p['reservedBatches']) for p in plans) + sum(decimal(w['reservedBatches']) for w in work),
        'dispatchedPreparedBytes': sum(decimal(w['dispatchedPreparedBytes']) for w in work),
        'dispatchedBatches': sum(decimal(w['dispatchedBatches']) for w in work),
        'observedSuccessfulRequests': len(observed),
        'observedEstimatedInputTokens': sum(decimal(w['estimatedInputTokens']) for w in observed),
        'observedProviderInputTokens': sum(decimal(w['providerInputTokens']) for w in observed if w['providerInputTokens'] is not None),
        'unknownProviderTokenBatches': sum(w['providerInputTokens'] is None for w in observed),
        'unknownBilledTokenBatches': sum(w['billedInputTokens'] is None for w in observed),
        'uncertainAttempts': sum(w['state'] == 'UNCERTAIN' for w in work),
    }
    need(all(decimal(actual[key]) == value for key, value in expected.items()), 'OBSERVER_EMBEDDING_ACCOUNTING')
    # PostgreSQL double counters can differ in representation; exact decimal comparison
    # is appropriate for this Ollama-only fixture, whose billed usage is unknown/zero.
    need(all(w['billedInputTokens'] is None for w in observed)
        and Decimal(actual['observedBilledInputTokens']) == 0, 'OBSERVER_BILLED_USAGE_UNKNOWN')
    return {key: str(value) for key, value in expected.items()}


def assess(stage, snapshot, scope, fault, prior=None, expired=None):
    """Return only evidence actually present. No state rewrite, wire-once or billing inference."""
    need(stage in STAGES, 'OBSERVER_STAGE')
    bounded_snapshot(snapshot, scope)
    caught = fault['caught']
    need(fault['status'] == 'WORKER_KILLED_MODEL_RESUMED' and fault['killed'] is True
        and fault['modelResumed'] is True and fault['scope'] == {k: scope[k] for k in
            ['organizationId', 'collectionId', 'generationId', 'documentId']}, 'OBSERVER_FAULT_BINDING')
    candidate = caught['indexedDocumentId']
    plan = one(snapshot['plans'], lambda p: p['indexedDocumentId'] == candidate, 'OBSERVER_PLAN')
    task = one(snapshot['tasks'], lambda t: t['id'] == caught['taskId'], 'OBSERVER_TASK')
    publication = one(snapshot['publications'], lambda p: p['id'] == candidate, 'OBSERVER_PUBLICATION')
    need(plan['generationId'] == publication['generationId'] == task['generationId'] == scope['generationId']
        and task['kind'] == 'INDEX_DOCUMENT' and task['indexedDocumentId'] == candidate
        and all(publication[key] == caught[key] for key in ['sourceVersionId', 'extractionId', 'extractorVersion',
            'buildRevision', 'metadataRevision']), 'OBSERVER_CANDIDATE_BINDING')
    need(all(plan[key] == caught[key] for key in ['sourceHash', 'profileHash', 'unitManifestHash', 'modelIdentity', 'unitCount'])
        and plan['completedUnits'] >= caught['completedUnits']
        and plan['boundaryScores'][:len(caught['boundaryScores'])] == caught['boundaryScores'], 'OBSERVER_PREFIX_CHANGED')
    need(len(caught['inFlight']) == 1, 'OBSERVER_ABANDONED_WORK')
    abandoned = one(snapshot['work'], lambda w: w['id'] == caught['inFlight'][0]['id'], 'OBSERVER_ABANDONED_WORK')
    need(abandoned['taskId'] == task['id'] and abandoned['purpose'] == 'BOUNDARY'
        and abandoned['leaseEpoch'] == caught['leaseEpoch']
        and abandoned['deadlineAt'] == caught['inFlight'][0]['deadlineAt'], 'OBSERVER_ABANDONED_WORK')
    checks = {'catalogAccounting': True, 'caughtPrefixPreserved': True}
    ledger = accounting(snapshot)
    if stage != 'recovered':
        generations = {g['id']: g for g in snapshot['generations']}
        need(generations[scope['oldGenerationId']]['status'] == 'ACTIVE'
            and generations[scope['generationId']]['status'] == 'BUILDING'
            and generations[scope['generationId']]['previousGenerationId'] == scope['oldGenerationId']
            and task['status'] == 'PROCESSING' and task['stage'] == 'SEMANTIC_PLANNING'
            and instant(task['leasedUntil'], prisma_utc_session=snapshot['sessionTimeZone'])
                >= instant(caught['leasedUntil'], prisma_utc_session=snapshot['sessionTimeZone']), 'OBSERVER_ABSENT_STATE')
        if plan['completedUnits'] == caught['completedUnits']:
            need(plan['checkpointSha256'] == caught['lastVectorSha256'], 'OBSERVER_CHECKPOINT_CHANGED')
    if stage == 'absent-checkpoint':
        need(snapshot['activeGenerationId'] == scope['oldGenerationId'] and plan['state'] == 'PLANNING'
            and plan['completedUnits'] < plan['unitCount'] and task['leaseEpoch'] == caught['leaseEpoch'], 'OBSERVER_ABSENT_STATE')
        checks['originalClaimStillRecorded'] = True
    else:
        need(prior is not None and prior['stage'] == 'absent-checkpoint' and prior['scope'] == scope, 'OBSERVER_PRIOR_CHECKPOINT')
        old = one(prior['snapshot']['plans'], lambda p: p['indexedDocumentId'] == candidate, 'OBSERVER_PLAN')
        need(all(plan[key] == old[key] for key in IMMUTABLE_PLAN)
            and plan['boundaryScores'][:len(old['boundaryScores'])] == old['boundaryScores'], 'OBSERVER_PREFIX_CHANGED')
        if stage == 'expired-before-restart':
            old_task = one(prior['snapshot']['tasks'], lambda t: t['id'] == task['id'], 'OBSERVER_TASK')
            old_abandoned = one(prior['snapshot']['work'], lambda w: w['id'] == abandoned['id'], 'OBSERVER_ABANDONED_WORK')
            need(task['leasedUntil'] == old_task['leasedUntil'] and abandoned['deadlineAt'] == old_abandoned['deadlineAt'],
                'OBSERVER_DEADLINES_CHANGED')
            need(snapshot['activeGenerationId'] == scope['oldGenerationId'] and task['leaseEpoch'] == caught['leaseEpoch']
                and plan['completedUnits'] == old['completedUnits'] and plan['boundaryScores'] == old['boundaryScores']
                and plan['checkpointSha256'] == old['checkpointSha256'] and plan['checkpointBytes'] == old['checkpointBytes'], 'OBSERVER_ABSENT_STATE')
            need(instant(snapshot['databaseNow']) > instant(task['leasedUntil'], prisma_utc_session=snapshot['sessionTimeZone'])
                and instant(snapshot['databaseNow']) > instant(abandoned['deadlineAt'], prisma_utc_session=snapshot['sessionTimeZone']),
                'OBSERVER_NATURAL_DEADLINE_NOT_PASSED')
            checks['naturalDeadlinesPassedWhileWorkerAbsent'] = True
        else:
            need(expired is not None and expired['stage'] == 'expired-before-restart' and expired['scope'] == scope,
                'OBSERVER_EXPIRED_CHECKPOINT_REQUIRED')
            need(snapshot['activeGenerationId'] == scope['generationId'] and plan['state'] == 'READY'
                and plan['completedUnits'] == plan['unitCount'] and plan['planHash'] is not None
                and plan['sealedAt'] is not None and plan['checkpointSha256'] is None
                and task['status'] == 'COMPLETE' and decimal(task['leaseEpoch']) > decimal(caught['leaseEpoch']), 'OBSERVER_RECOVERY_NOT_COMPLETE')
            old_task = one(prior['snapshot']['tasks'], lambda t: t['id'] == task['id'], 'OBSERVER_TASK')
            need(task['attempts'] >= old_task['attempts'] and task['continuations'] >= old_task['continuations'],
                'OBSERVER_TASK_COUNTERS_REWOUND')
            generations = {g['id']: g for g in snapshot['generations']}
            need(generations[scope['generationId']]['status'] == 'ACTIVE'
                and generations[scope['generationId']]['previousGenerationId'] == scope['oldGenerationId']
                and generations[scope['oldGenerationId']]['status'] == 'RETIRED', 'OBSERVER_RECOVERY_GENERATIONS')
            current = one(snapshot['publications'], lambda p: p['id'] == candidate, 'OBSERVER_PUBLICATION')
            desired = one(snapshot['documents'], lambda d: d['generationId'] == scope['generationId'], 'OBSERVER_DESIRED')
            need(current['status'] == 'PUBLISHED' and current['publishedAt'] is not None
                and desired['publishedIndexedDocumentId'] == candidate and desired['desiredVersionId'] == current['sourceVersionId']
                and desired['desiredExtractionId'] == current['extractionId'] and desired['desiredMetadataRevision'] == current['metadataRevision']
                and desired['buildRevision'] == current['buildRevision'], 'OBSERVER_PUBLICATION')
            active_ranges = [{'ordinal': c['ordinal'], 'start': c['startOffset'], 'end': c['endOffset']}
                for c in sorted(snapshot['chunks'], key=lambda c: c['ordinal'])
                if c['indexedDocumentId'] == candidate and c['kind'] == 'CHILD']
            need(plan['finalRanges'] == active_ranges, 'OBSERVER_FINAL_LAYOUT')
            for publication in snapshot['publications']:
                if publication['status'] not in {'PUBLISHED', 'RETIRED'}:
                    continue
                hold = one(snapshot['holds'], lambda h: h['indexedDocumentId'] == publication['id'], 'OBSERVER_SOURCE_HOLD')
                need(publication['sourceStatus'] == 'READY' and publication['contentState'] == 'AVAILABLE'
                    and publication['discardedAt'] is None and hold['state'] in {'LIVE', 'RETIRED'}
                    and (hold['state'] == 'LIVE' or instant(hold['retainUntil'], prisma_utc_session=snapshot['sessionTimeZone'])
                        > instant(snapshot['databaseNow'])), 'OBSERVER_SOURCE_HOLD')
            old_work = {w['id']: w for w in prior['snapshot']['work']}
            now_work = {w['id']: w for w in snapshot['work']}
            need(all(key in now_work and all(now_work[key][field] == w[field] for field in IMMUTABLE_WORK)
                for key, w in old_work.items()), 'OBSERVER_HISTORY_CHANGED')
            new_boundary = [w for w in snapshot['work'] if w['generationId'] == scope['generationId']
                and w['purpose'] == 'BOUNDARY' and decimal(w['leaseEpoch']) > decimal(caught['leaseEpoch'])]
            need(new_boundary and all(re.fullmatch(r'boundary:[0-9]{1,4}', w['operationKey'])
                and int(w['operationKey'].split(':')[1]) >= old['completedUnits'] for w in new_boundary), 'OBSERVER_ACCEPTED_PREFIX_REDISPATCHED')
            need(abandoned['state'] == 'UNCERTAIN' and abandoned['uncertainAt'] is not None
                and instant(abandoned['uncertainAt'], prisma_utc_session=snapshot['sessionTimeZone'])
                    >= instant(abandoned['deadlineAt'], prisma_utc_session=snapshot['sessionTimeZone'])
                and decimal(abandoned['reservedPreparedBytes']) == 0 and decimal(abandoned['reservedBatches']) == 0,
                'OBSERVER_ABANDONED_OUTCOME_NOT_UNCERTAIN')
            need(all(ledger[key] == '0' for key in ['reservedPlanBytes', 'reservedPreparedBytes', 'reservedBatches']), 'OBSERVER_RESERVATIONS_REMAIN')
            children = [c for c in snapshot['chunks'] if c['kind'] == 'CHILD']
            active_children = [c for c in children if c['indexedDocumentId'] == candidate]
            # Activation retires the generation while keeping its successfully
            # published candidates/pointers readable during the real grace.
            # A retired publication in an otherwise active generation is also
            # charged until acknowledged purge. Do not count CLEANING/CLEANED
            # history as a successful retained publication for this proof.
            retained = [p['id'] for p in snapshot['publications'] if p['status'] == 'RETIRED'
                or (p['status'] == 'PUBLISHED' and generations[p['generationId']]['status'] == 'RETIRED')]
            retained_children = [c for c in children if c['indexedDocumentId'] in retained]
            account = snapshot['indexAccounting']
            need(len(active_children) == current['chunkCount'] == current['materializedChunks'] == desired['targetChunkCount']
                and decimal(account['activeChunks']) == len(active_children)
                and decimal(account['retainedChunks']) == len(retained_children) and decimal(account['reservedChunks']) == 0,
                'OBSERVER_CHILD_ACCOUNTING')
            checks.update({'newClaimEpoch': True, 'BActivated': True, 'acceptedPrefixNotLogicallyRedispatched': True,
                'abandonedDispatchUncertain': True, 'unusedReservationsZero': True})
    return {'stage': stage, 'scope': scope, 'checks': checks, 'acceptedPrefixUnits': plan['completedUnits'] if prior is None
        else one(prior['snapshot']['plans'], lambda p: p['indexedDocumentId'] == candidate, 'OBSERVER_PLAN')['completedUnits'],
        'abandonedWorkState': abandoned['state'], 'logicalLedger': ledger,
        'providerWireExactlyOnce': 'NOT_ESTABLISHED', 'billingAcceptance': 'NOT_ESTABLISHED',
        'physicalVectorAcceptance': 'NOT_OBSERVED', 'capacityAcceptance': 'NOT_RUN'}
