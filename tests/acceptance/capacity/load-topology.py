"""Guarded, explicit lifecycle for one fresh local load fixture; no work on import."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import quote

from load_policy_registry import get_load_policy, load_policy_for_state, policy_sha256
from load_topology_policy import (ROOT, CACHE, NAMESPACE, SERVICES, DEFAULT_LIMITS, LOAD_POLICY,
    WORKFLOW_HISTORY, RUNTIME_ENTRIES,
    ENVIRONMENT_KEYS, GuardError, canonical, digest, entry_digest, labels, nano_cpus,
    read_state, require, state_path, validate_container, validate_fixture,
    validate_state, validate_volume, valid_hash, volume_identity)
sys.path.insert(0, str(ROOT / 'tests/acceptance/restore'))
from m7c_restore_common import (base_environment, bounded_stream, private_directory,
    read_private_bytes, run, save_json, state_lock)

DRAFT_ONLY = False
HERE = Path(__file__).resolve().parent
IMAGES = {'postgres': 'postgres:18-alpine', 'vector': 'pxdv.be/vectorix/postgres-vector:local',
    'redis': 'redis:8-alpine',
    'rustfs': 'rustfs/rustfs:1.0.3@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b',
    'ollama': 'ollama/ollama:0.40.8'}
PINNED_HELPERS = [
    'load-bootstrap-runtime.mjs',
    'load-bootstrap.mjs',
    'load-bucket.mjs',
    'load-corpus.mjs',
    'load-import-collections.mjs',
    'load-import-core.mjs',
    'load-import-documents.mjs',
    'load-import-protocol.mjs',
    'load-import-runtime-content.mjs',
    'load-import-runtime-files.mjs',
    'load-import-runtime-policy.mjs',
    'load-import-runtime-services.mjs',
    'load-import-runtime.mjs',
    'load-observer-core.mjs',
    'load-observer-layout.mjs',
    'load-observer-runtime.mjs',
    'load-observer-sql.mjs',
    'load-observer.mjs',
    'load-private.mjs',
    'load-resources-runtime.mjs',
    'load-resources.mjs',
    'load-sizes-runtime.mjs',
    'load-sizes.mjs',
    'load-topology.py',
    'load-traffic-async-guard.mjs',
    'load-traffic-catalog.mjs',
    'load-traffic-composition.mjs',
    'load-traffic-ingestion-observer-history.mjs',
    'load-traffic-ingestion-observer-runtime.mjs',
    'load-traffic-ingestion-observer-sql.mjs',
    'load-traffic-ingestion-observer.mjs',
    'load-traffic-ingestion.mjs',
    'load-traffic-inventory.mjs',
    'load-traffic-latency.mjs',
    'load-traffic-oracle.mjs',
    'load-traffic-private.mjs',
    'load-traffic-resource-worker.mjs',
    'load-traffic-resources.mjs',
    'load-traffic-runtime.mjs',
    'load-traffic-sources.mjs',
    'load-traffic.mjs',
    'load-transport.mjs',
    'load_topology_policy.py',
    'load-policy-registry.mjs',
    'load-observer-policy.mjs',
    'load_policy_registry.py',
    'load-light-corpus.mjs',
    'load-light-policy.mjs',
]
PRODUCTION_PATHS = ['apps/api', 'apps/workers', 'apps/web', 'packages', 'pnpm-lock.yaml', 'package.json']


def save(state):
    validate_state(state, state['runId'])
    save_json(state_path(state['runId'], state['experimentPolicyId']), state)


def inspect(name, kind='container'):
    value = json.loads(run(['docker', kind, 'inspect', name], timeout=10))
    require(isinstance(value, list) and len(value) == 1, 'load-one-inspected-resource')
    return value[0]


def command_result(arguments, maximum=16384, timeout=10):
    return bounded_stream(arguments, capture=True, maximum=maximum, timeout=timeout, allowed_exit_codes=(0, 1))


def free_port(port=None):
    with socket.socket() as handle:
        handle.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            handle.bind(('127.0.0.1', port or 0))
        except OSError:
            raise GuardError('load-loopback-port-unavailable') from None
        return handle.getsockname()[1]


def free_space():
    require(shutil.disk_usage(CACHE).free >= LOAD_POLICY['minimumFreeBytes'], 'load-four-gib-free-required')


def migration_manifest():
    paths = sorted((ROOT / 'packages/db/prisma/migrations').glob('*/migration.sql'))
    require(1 <= len(paths) <= 64, 'load-migration-chain-bound')
    return {path.parent.name: digest(path.read_bytes()) for path in paths}


def helper_manifest():
    """Hash the explicit complete runtime dependency set with finite files/bytes; never discover extra helpers by glob."""
    require(1 <= len(PINNED_HELPERS) <= 63 and len(PINNED_HELPERS) == len(set(PINNED_HELPERS))
        and all(isinstance(name, str) and re.fullmatch('[A-Za-z0-9_.-]{1,100}', name)
            and name not in {'.', '..', 'shared-restore-common.py'} for name in PINNED_HELPERS),
        'load-explicit-helper-inventory')
    paths = {name: HERE / name for name in PINNED_HELPERS}
    paths['shared-restore-common.py'] = ROOT / 'tests/acceptance/restore/m7c_restore_common.py'
    result, total = {}, 0
    for name, path in paths.items():
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(ROOT)
            and path.stat().st_uid == os.getuid() and path.stat().st_size <= 2 * 1024 ** 2,
            'load-helper-file-safety')
        with path.open('rb') as handle:
            value = handle.read(2 * 1024 ** 2 + 1)
        total += len(value)
        require(len(value) <= 2 * 1024 ** 2 and total <= 8 * 1024 ** 2, 'load-helper-byte-bound')
        result[name] = digest(value)
    return result


def corpus_manifest(selected=None):
    """Pin the unchanged generated-load manifests plus every frozen reference original and canonical file."""
    selected = selected or get_load_policy('DEFAULT_V1')
    reference = json.loads((ROOT / 'tests/acceptance' / 'quality/reference-v1/manifest.json').read_text())
    require(len(reference['documents']) == 24, 'load-reference-document-count')
    names = ['reference-v1/' + name for name in ['manifest.json', 'queries.json', 'qrels.json', 'policy.json',
        'development-queries.json']]
    for row in reference['documents']:
        require(re.fullmatch(r'originals/m7c-[fd][0-9]{2}-(?:en|fr)-v1\.(?:txt|md|pdf|docx)', row['originalPath'])
            and re.fullmatch(r'canonical/m7c-[fd][0-9]{2}-(?:en|fr)-v1\.json', row['canonicalPath']),
            'load-reference-path-bound')
        names.extend('reference-v1/' + row[key] for key in ['originalPath', 'canonicalPath'])
    names.extend(selected['corpusRoot'] + '/' + name for name in ['pilot-preflight.json', 'full-preflight.json',
        'pure-preparation-proof.json' if selected['id'] == 'DEFAULT_V1' else 'preparation-proof.json'])
    require(len(names) == len(set(names)) and len(names) <= 64, 'load-corpus-file-bound')
    total, result = 0, {}
    for name in sorted(names):
        corpus_directory = ROOT / 'tests/acceptance/quality' if name.startswith('reference-v1/') else (ROOT / 'tests/acceptance/capacity' if selected['id'] == 'DEFAULT_V1' else HERE)
        path = corpus_directory / name
        require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(corpus_directory)
            and path.stat().st_size <= 2 * 1024 ** 2, 'load-corpus-file-safety')
        value = path.read_bytes()
        total += len(value)
        require(total <= 8 * 1024 ** 2, 'load-corpus-manifest-total-bound')
        result[name] = digest(value)
    return result


def artifact_tree(directory):
    rows, total, visited, started = [], 0, 0, time.monotonic()
    for file in directory.rglob('*'):
        visited += 1
        require(visited <= 100000 and time.monotonic() - started <= 60, 'load-artifact-enumeration-bound')
        relative = file.relative_to(directory).as_posix()
        if not file.is_file() or relative.startswith('.next/cache/') or '/.next/cache/' in relative:
            continue
        require(file.resolve().is_relative_to(ROOT) and file.name not in
            {'.env', '.env.local', '.env.production', '.env.production.local'}, 'load-safe-artifact-tree')
        total += file.stat().st_size
        require(total <= 512 * 1024 ** 2 and len(rows) < 30000, 'load-artifact-byte-bound')
        rows.append({'path': relative, 'bytes': file.stat().st_size, 'sha256': entry_digest(file)})
    require(rows, 'load-nonempty-production-tree')
    return {'treeSha256': digest(canonical(sorted(rows, key=lambda value: value['path']))), 'treeFiles': len(rows)}


def build_manifest():
    entries = {}
    for service in ['api', 'workers', 'web']:
        entry = ROOT / ('apps/' + service + '/dist/index.mjs' if service != 'web'
            else 'apps/web/.next/standalone/apps/web/server.js')
        require(entry.is_file(), 'load-existing-production-build-required')
        if service == 'web':
            require((entry.parent / '.next/static').is_dir() and (entry.parent / 'public').is_dir(),
                'load-standalone-assets-required-before-pinning')
        entries[service] = {'entry': str(entry), 'entrySha256': entry_digest(entry), **artifact_tree(entry.parent)}
    return entries


def verify_pins(state):
    require(run(['git', 'rev-parse', 'HEAD']).decode().strip() == state['commit'], 'load-head-drift')
    require(command_result(['git', 'diff', '--quiet', 'HEAD', '--', *PRODUCTION_PATHS])['exitCode'] == 0,
        'load-dirty-production-source')
    require(digest((ROOT / 'pnpm-lock.yaml').read_bytes()) == state['lockfileSha256']
        and digest((ROOT / 'packages/db/prisma.config.ts').read_bytes()) == state['prismaConfigSha256']
        and migration_manifest() == state['migrations'] and helper_manifest() == state['acceptanceSources'],
        'load-release-input-drift')
    require(corpus_manifest(load_policy_for_state(state)) == state['corpusFiles'], 'load-corpus-file-drift')
    manifest = json.loads((ROOT / 'tests/acceptance/quality/reference-v1/manifest.json').read_text())
    require(manifest['corpusDigest'] == state['referenceCorpusDigest'], 'load-corpus-digest-drift')
    require(build_manifest() == state['builds'], 'load-built-artifact-drift')


def owned(state, service, running=None):
    saved = state['resources'][service]
    require(saved['id'] is not None, 'load-resource-without-recorded-container')
    value = validate_container(state, service, inspect(saved['id']), running=running)
    validate_volume(state, service, inspect(saved['volume'], 'volume'))
    return value


def process_identity(pid):
    try:
        process = Path('/proc') / str(pid)
        fields = (process / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] in {'Z', 'X', 'x'}:
            return None
        return {'startTicks': fields[19], 'command': (process / 'cmdline').read_bytes().split(b'\0'),
            'cwd': str(Path(os.readlink(process / 'cwd'))),
            'environment': (process / 'environ').read_bytes().split(b'\0'),
            'uid': process.stat().st_uid}
    except (FileNotFoundError, ProcessLookupError):
        return None


def process_alive(state, saved):
    if saved['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        return False
    value = process_identity(saved['pid'])
    if not value or value['startTicks'] != saved['startTicks']:
        return False
    require(value['uid'] == os.getuid() and value['cwd'] == saved['cwd'], 'load-process-owner-cwd')
    exact = saved['entry'].encode() in value['command']
    next_entry = value['command'][0].startswith(b'next-server ') and saved['service'] == 'web'
    require(exact or next_entry, 'load-process-command')
    expected = {'VECTORIX_LOAD_RUN': state['runId'], 'VECTORIX_LOAD_ROLE': saved['service']}
    for key, content in expected.items():
        matches = [item for item in value['environment'] if item.startswith(key.encode() + b'=')]
        require(matches == [(key + '=' + content).encode()], 'load-process-run-markers')
    for key, content in state['environment'].items():
        require([item for item in value['environment'] if item.startswith(key.encode() + b'=')] ==
            [(key + '=' + content).encode()], 'load-process-runtime-environment')
    if saved['service'] in {'api', 'web'}:
        require(('PORT=' + str(state['ports'][saved['service']])).encode() in value['environment'], 'load-process-port')
    if saved['service'] == 'load':
        command = value['command']
        position = command.index(saved['entry'].encode())
        require(command[position + 1:] in [
            [b'--state', str(state_path(state['runId'], state['experimentPolicyId'])).encode(), b'--run', state['runId'].encode(),
                b'--mode', saved['workflow'].encode(), b''],
            [b'--state', str(state_path(state['runId'], state['experimentPolicyId'])).encode(), b'--run', state['runId'].encode(),
                b'--mode', saved['workflow'].encode()]], 'load-foreground-exact-arguments')
    require(entry_digest(saved['entry']) == saved['entrySha256'], 'load-process-entry-drift')
    return True


def process_records(state):
    records = [*state['processes'].values(), *state['dashboardProcesses'].values()]
    if state.get('loadProcess'):
        records.append(state['loadProcess'])
    return records


def stop_apps(state):
    records = process_records(state)
    for group in [[item for item in records if item['service'] == 'load'],
                  [item for item in records if item['service'] != 'load']]:
        for saved in group:
            if process_alive(state, saved):
                os.kill(saved['pid'], signal.SIGTERM)
        deadline = time.monotonic() + state['loadPolicy']['gracefulStopSeconds']
        while any(process_alive(state, saved) for saved in group):
            require(time.monotonic() < deadline, 'load-graceful-app-stop-timeout')
            time.sleep(0.1)


def db_query(state, sql, *, service='postgres'):
    require(sql.lstrip().upper().startswith('SELECT') and len(sql) <= 16384, 'load-readonly-query')
    resource = owned(state, service, running=True)
    database = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
    value = run(['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000',
        resource['Id'], 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', sql], timeout=20)
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        raise GuardError('load-readonly-query-shape') from None


def assert_empty(state):
    result = db_query(state, '''SELECT json_build_object(
      'users',(SELECT count(*) FROM public."user"),'organizations',(SELECT count(*) FROM public.organization),
      'members',(SELECT count(*) FROM public.member),'roles',(SELECT count(*) FROM public."organizationRole"),
      'keys',(SELECT count(*) FROM public.apikey),'documents',(SELECT count(*) FROM public."Document"),
      'collections',(SELECT count(*) FROM public."Collection"))''')
    require(set(result) == {'users', 'organizations', 'members', 'roles', 'keys', 'documents', 'collections'}
        and all(type(value) is int and value == 0 for value in result.values()), 'load-bootstrap-requires-empty-catalog')


def scoped_fixture(state):
    return validate_fixture(json.loads(read_private_bytes(state_path(state['runId'], state['experimentPolicyId']).parent / 'fixture.json',
        128 * 1024)), state)


def assert_catalog_scope(state, fixture):
    """Metadata-only aggregate: bound all accepted rows to the exact synthetic identities before any workflow."""
    validate_fixture(fixture, state)
    organizations = ','.join("'" + value + "'" for value in fixture['organizationIds'])
    users = ','.join("'" + value['userId'] + "'" for value in fixture['users'].values())
    # IDs have passed the conservative no-quote alphabet. No content or secrets enter this SQL/result.
    result = db_query(state, '''SELECT json_build_object(
      'organizations',(SELECT count(*) FROM public.organization),
      'outsideOrganizations',(SELECT count(*) FROM public.organization WHERE id NOT IN (''' + organizations + ''')),
      'users',(SELECT count(*) FROM public."user"),
      'outsideUsers',(SELECT count(*) FROM public."user" WHERE id NOT IN (''' + users + ''')),
      'superadmins',(SELECT count(*) FROM public."user" WHERE "isSuperAdmin"),
      'keys',(SELECT count(*) FROM public.apikey),
      'documents',(SELECT count(*) FROM public."Document"),
      'outsideDocuments',(SELECT count(*) FROM public."Document" WHERE "organizationId" NOT IN (''' + organizations + ''')),
      'collections',(SELECT count(*) FROM public."Collection"),
      'outsideCollections',(SELECT count(*) FROM public."Collection" WHERE "organizationId" NOT IN (''' + organizations + ''')),
      'members',(SELECT coalesce(json_agg(json_build_object('id',id,'userId',"userId",'organizationId',"organizationId")
        ORDER BY id),'[]'::json) FROM public.member))''')
    expected = sorted([{'id': value['memberId'], 'userId': value['userId'], 'organizationId': value['organizationId']}
        for value in fixture['users'].values()], key=lambda value: value['id'])
    require(result['organizations'] == 2 and result['users'] == 3 and result['members'] == expected
        and all(result[key] == 0 for key in ['outsideOrganizations', 'outsideUsers', 'superadmins', 'keys',
            'outsideDocuments', 'outsideCollections'])
        and type(result['documents']) is int and 0 <= result['documents'] <= state['loadPolicy']['maximumDocuments']
        and type(result['collections']) is int and 0 <= result['collections'] <= state['loadPolicy']['maximumCollections'],
        'load-exact-synthetic-catalog-bound')


def verify_schema(state):
    rows = db_query(state, '''SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,
      'complete',finished_at IS NOT NULL AND rolled_back_at IS NULL) ORDER BY migration_name),'[]'::json)
      FROM public."_prisma_migrations"''')
    require({row['name']: row['checksum'] for row in rows} == state['migrations'] and len(rows) == len(state['migrations'])
        and all(row['complete'] is True for row in rows), 'load-approved-schema-not-fully-deployed')
    roles_sql = "SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_roles WHERE rolname !~ '^pg_'"
    require(db_query(state, roles_sql) == ['postgres'], 'load-app-role-inventory')
    require(db_query(state, roles_sql, service='vector') == ['postgres', 'vectorix_indexer', 'vectorix_runtime'],
        'load-vector-role-inventory')
    extensions = db_query(state, "SELECT json_object_agg(extname,extversion) FROM pg_extension", service='vector')
    require(extensions.get('vector') == '0.8.7' and extensions.get('vectorscale') == '0.9.1', 'load-vector-extensions')
    roles = db_query(state, "SELECT to_json(bool_and(NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)) FROM pg_roles WHERE rolname IN ('vectorix_indexer','vectorix_runtime')", service='vector')
    require(roles is True, 'load-vector-least-privilege')


def guard(state, purpose, *, require_caller=False):
    """Read-only child preflight; intentionally does not reacquire the caller's lifecycle lock."""
    validate_state(state, state['runId'], complete=True)
    verify_pins(state)
    require(purpose in {'bootstrap', 'bucket', 'import', 'dashboard'}, 'load-guard-purpose')
    for service in SERVICES:
        owned(state, service, running=True)
    verify_schema(state)
    if purpose in {'bootstrap', 'bucket'}:
        require(state['phase'] in ({'SCHEMA_VERIFIED_EMPTY', 'BOOTSTRAPPING'} if purpose == 'bootstrap'
            else {'APP_DB_EMPTY_SCHEMA_REQUIRED'}), 'load-guard-setup-phase')
        assert_empty(state)
        if purpose == 'bootstrap':
            require('api' in state['processes'] and process_alive(state, state['processes']['api']),
                'load-bootstrap-owned-api-required')
    else:
        require(state['phase'] in {'READY_FOR_LOAD_IMPORT', 'LOAD_WORKFLOW_COMPLETE', 'LOAD_WORKFLOW_INCOMPLETE'},
            'load-guard-load-phase')
        for service in ['api', 'workers']:
            require(service in state['processes'] and process_alive(state, state['processes'][service]),
                'load-required-owned-runtime')
        assert_catalog_scope(state, scoped_fixture(state))
        if require_caller:
            saved = state.get('loadProcess')
            require(purpose == 'import' and saved is not None and saved['pid'] == os.getppid()
                and process_alive(state, saved), 'load-guard-exact-foreground-parent')
    return {'schemaVersion': 1, 'namespace': state['namespace'],
        'experimentPolicyId': state['experimentPolicyId'], 'experimentPolicySha256': state['experimentPolicySha256'], 'runId': state['runId'], 'purpose': purpose,
        'resourceOwnership': True, 'databaseReadOnly': True, 'bootstrapFreshness': purpose in {'bootstrap', 'bucket'}}


def initial_state(run_id, ports, images, model, builds, commit, *, limits=None, experiment_id="DEFAULT_V1"):
    """Construct state from inspected inputs and bounded local source-pin reads."""
    selected = get_load_policy(experiment_id)
    secret = {key: secrets.token_urlsafe(24) for key in ['postgres', 'indexer', 'runtime', 's3Secret']}
    secret['s3Access'] = selected['emailPrefix'] + '-' + run_id
    api, web = 'http://127.0.0.1:' + str(ports['api']), 'http://127.0.0.1:' + str(ports['web'])
    state = {'schemaVersion': 1, 'namespace': selected['namespace'], 'runId': run_id, 'prefix': selected['namespace'] + '-' + run_id,
        'phase': 'PREPARING', 'ports': ports, 'images': images, 'resourceLimits': copy.deepcopy(limits or DEFAULT_LIMITS),
        'resources': {}, 'modelVolume': model, 'builds': builds, 'processes': {}, 'dashboardProcesses': {},
        'loadProcess': None, 'workflowHistory': [], 'infrastructureSecrets': secret, 'commit': commit,
        'lockfileSha256': digest((ROOT / 'pnpm-lock.yaml').read_bytes()),
        'prismaConfigSha256': digest((ROOT / 'packages/db/prisma.config.ts').read_bytes()),
        'migrations': migration_manifest(), 'acceptanceSources': helper_manifest(),
        'corpusFiles': corpus_manifest(selected), 'loadPolicy': copy.deepcopy(selected['loadPolicy']),
        'experimentPolicyId': selected['id'], 'experimentPolicySha256': policy_sha256(selected),
        'referenceCorpusDigest': json.loads((ROOT / 'tests/acceptance/quality/reference-v1/manifest.json').read_text())['corpusDigest'],
        'applicationDatabase': selected['databasePrefix'] + '_app_' + run_id + '_test',
        'vectorDatabase': selected['databasePrefix'] + '_vectors_' + run_id + '_test', 'apiOrigin': api, 'webOrigin': web}
    env = dict.fromkeys(ENVIRONMENT_KEYS, '')
    env.update(NODE_ENV='production', TZ='UTC', VECTORIX_TIME_ZONE='UTC',
        DATABASE_URL='postgresql://postgres:' + quote(secret['postgres'], safe='') + '@127.0.0.1:' + str(ports['postgres']) + '/' + state['applicationDatabase'],
        VECTOR_DATABASE_URL='postgresql://vectorix_runtime:' + quote(secret['runtime'], safe='') + '@127.0.0.1:' + str(ports['vector']) + '/' + state['vectorDatabase'],
        VECTOR_DATABASE_PROVISIONING_URL='postgresql://vectorix_indexer:' + quote(secret['indexer'], safe='') + '@127.0.0.1:' + str(ports['vector']) + '/' + state['vectorDatabase'],
        VECTOR_DATABASE_SCHEMA='vector_collections', REDIS_URL='redis://127.0.0.1:' + str(ports['redis']),
        BETTER_AUTH_SECRET=secrets.token_urlsafe(48), ENCRYPTION_SECRET=secrets.token_hex(32),
        BETTER_AUTH_URL=api, API_URL=api, VECTORIX_WEB_URL=web, TRUSTED_ORIGINS=web,
        ALLOW_ACCOUNT_CREATION='true', ALLOW_ORGANIZATION_CREATION='true', VECTORIX_WEB_PUSH_ENABLED='false',
        VECTORIX_DEFAULT_S3_ENDPOINT='http://127.0.0.1:' + str(ports['rustfs']), VECTORIX_DEFAULT_S3_REGION='us-east-1',
        VECTORIX_DEFAULT_S3_BUCKET=selected['emailPrefix'] + '-' + run_id, VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE='true',
        VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=secret['s3Access'], VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=secret['s3Secret'],
        VECTORIX_DEFAULT_OLLAMA_ENDPOINT='http://127.0.0.1:' + str(ports['ollama']),
        PASSKEY_RP_ID='127.0.0.1', PASSKEY_RP_NAME='Vectorix isolated load acceptance', PASSKEY_ORIGINS=web)
    env['VECTORIX_S3_ALLOWED_ENDPOINTS'] = env['VECTORIX_DEFAULT_S3_ENDPOINT']
    env['VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS'] = env['VECTORIX_DEFAULT_OLLAMA_ENDPOINT']
    state['environment'] = env
    return validate_state(state, run_id)


def create_service(state, service):
    require(service not in state['resources'], 'load-no-resource-overwrite')
    name = state['prefix'] + '-' + service
    container_names = run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'])
    require(not container_names.strip(), 'load-existing-container-refused')
    if service == 'ollama':
        volume, identity = state['modelVolume']['name'], state['modelVolume']['identity']
    else:
        volume = name + '-data'
        require(command_result(['docker', 'volume', 'inspect', volume])['exitCode'] != 0, 'load-existing-volume-refused')
        label_args = [item for key, value in labels(state['runId'], service, state['experimentPolicyId']).items() for item in ['--label', key + '=' + value]]
        run(['docker', 'volume', 'create', *label_args, volume])
        created = inspect(volume, 'volume')
        require(created['Name'] == volume and created['Driver'] == 'local' and created.get('Options') in [None, {}]
            and created.get('Labels') == labels(state['runId'], service, state['experimentPolicyId']), 'load-new-volume-identity')
        identity = volume_identity(created)
    state['resources'][service] = {'id': None, 'name': name, 'imageId': state['images'][service],
        'volume': volume, 'volumeIdentity': identity}
    save(state)
    values = {}
    secret = state['infrastructureSecrets']
    if service in {'postgres', 'vector'}:
        values.update(POSTGRES_PASSWORD=secret['postgres'], POSTGRES_DB=state['applicationDatabase' if service == 'postgres' else 'vectorDatabase'])
        if service == 'vector':
            values.update(VECTOR_PROVISIONER_PASSWORD=secret['indexer'], VECTOR_RUNTIME_PASSWORD=secret['runtime'])
    elif service == 'rustfs':
        values.update(RUSTFS_ACCESS_KEY=secret['s3Access'], RUSTFS_SECRET_KEY=secret['s3Secret'], RUSTFS_REGION='us-east-1',
            RUSTFS_CONSOLE_ENABLE='false', RUSTFS_OBS_LOG_DIRECTORY='/tmp/logs')
    elif service == 'ollama':
        values.update(OLLAMA_HOST='0.0.0.0:11434', OLLAMA_NUM_PARALLEL='1')
    arguments = ['docker', 'create', '--pull=never', '--name', name, '--network=bridge']
    for key, value in labels(state['runId'], service, state['experimentPolicyId']).items():
        arguments += ['--label', key + '=' + value]
    arguments += ['--cpus', state['resourceLimits'][service]['cpus'], '--memory', str(state['resourceLimits'][service]['memoryBytes']),
        '--mount', 'type=volume,src=' + volume + ',dst=' + SERVICES[service][1] + (',readonly' if service == 'ollama' else ''),
        '-p', '127.0.0.1:' + str(state['ports'][service]) + ':' + str(SERVICES[service][0])]
    for key in values:
        arguments += ['-e', key]
    arguments += [state['images'][service]]
    if service == 'rustfs':
        arguments += ['/data']
    identifier = run(arguments, environment={**base_environment(), **values}, timeout=55).decode().strip()
    require(valid_hash(identifier), 'load-new-container-id')
    state['resources'][service]['id'] = identifier
    save(state)
    owned(state, service, running=False)
    run(['docker', 'start', identifier], timeout=30)
    owned(state, service, running=True)
    if service in {'postgres', 'vector'}:
        database = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
        deadline = time.monotonic() + 55
        while time.monotonic() < deadline:
            result = subprocess.run(['docker', 'exec', identifier, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database],
                env=base_environment(), cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            require(result.returncode in {0, 1, 2}, 'load-postgres-readiness-command')
            if result.returncode == 0:
                return
            time.sleep(0.5)
        raise GuardError('load-postgres-tcp-readiness')


def prepare(run_id, model_name, image_references, experiment_id="DEFAULT_V1"):
    path = state_path(run_id, experiment_id)
    require(not path.parent.exists(), 'load-fresh-run-directory-required')
    CACHE.mkdir(parents=True, exist_ok=True)
    require(CACHE.resolve() == CACHE and CACHE.is_dir(), 'load-cache-path')
    free_space()
    require(model_name and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{1,127}', model_name), 'load-explicit-model-volume-required')
    ports = {}
    for service in [*SERVICES, 'api', 'web', 'admin']:
        candidate = free_port()
        require(candidate not in ports.values(), 'load-distinct-selected-ports')
        ports[service] = candidate
    images = {}
    for service, reference in image_references.items():
        require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,255}', reference), 'load-local-image-reference')
        value = inspect(reference, 'image')
        require(set(value['Config'].get('Volumes') or {}).issubset({SERVICES[service][1]}), 'load-image-extra-volume')
        images[service] = value['Id']
    model = inspect(model_name, 'volume')
    require(model['Name'] == model_name and model['Driver'] == 'local' and model.get('Options') in [None, {}],
        'load-existing-plain-model-volume')
    state = initial_state(run_id, ports, images, {'name': model_name, 'identity': volume_identity(model)}, build_manifest(),
        run(['git', 'rev-parse', 'HEAD']).decode().strip(), experiment_id=experiment_id)
    verify_pins(state)
    path.parent.mkdir(mode=0o700)
    save_json(path, state, exclusive=True)
    for service in SERVICES:
        create_service(state, service)
    state['phase'] = 'APP_DB_EMPTY_SCHEMA_REQUIRED'
    save(state)
    return state


def deploy(state):
    require(state['phase'] == 'APP_DB_EMPTY_SCHEMA_REQUIRED' and not process_records(state), 'load-deploy-empty-phase')
    verify_pins(state)
    for service in SERVICES:
        owned(state, service, running=True)
    directory = ROOT / 'packages/db'
    require(all(not (directory / name).exists() for name in ['.env', '.env.local', '.env.production', '.env.production.local']),
        'load-prisma-dotenv-refused')
    binary = directory / 'node_modules/prisma/build/index.js'
    require(binary.is_file() and binary.resolve().is_relative_to(ROOT), 'load-existing-prisma-cli')
    run([shutil.which('node'), str(binary), 'migrate', 'deploy', '--config', str(directory / 'prisma.config.ts')],
        environment={**base_environment(), 'DATABASE_URL': state['environment']['DATABASE_URL']}, directory=directory, timeout=120)
    verify_schema(state)
    assert_empty(state)


def child(state, filename, *, timeout=120):
    require(filename in {'load-bootstrap.mjs', 'load-bucket.mjs'}, 'load-known-child')
    arguments = (['--run', state['runId'], '--experiment', state['experimentPolicyId']] if filename == 'load-bootstrap.mjs'
        else ['--state', str(state_path(state['runId'], state['experimentPolicyId'])), '--run', state['runId']])
    result = bounded_stream([shutil.which('node'), str(HERE / filename), *arguments],
        environment={**base_environment(), **state['environment']}, capture=True, maximum=32768, timeout=timeout,
        allowed_exit_codes=(0, 1))
    try:
        value = json.loads(result['data'])
    except json.JSONDecodeError:
        raise GuardError('load-child-response-shape') from None
    require(isinstance(value, dict) and result['exitCode'] == 0 and value.get('completed') is True
        and value.get('runId') == state['runId'], 'load-child-refused')
    return value


def schema_ready(state):
    guard(state, 'bucket')
    child(state, 'load-bucket.mjs')
    verify_schema(state)
    assert_empty(state)
    state['phase'] = 'SCHEMA_VERIFIED_EMPTY'
    save(state)


def bootstrap(state):
    require(state['phase'] == 'SCHEMA_VERIFIED_EMPTY', 'load-bootstrap-phase')
    directory = state_path(state['runId'], state['experimentPolicyId']).parent
    require(not (directory / 'fixture.json').exists() and not (directory / 'bootstrap-progress.json').exists(),
        'load-bootstrap-refuses-replay')
    guard(state, 'bootstrap')
    state['phase'] = 'BOOTSTRAPPING'
    save(state)
    child(state, 'load-bootstrap.mjs', timeout=180)
    validate_fixture(json.loads(read_private_bytes(directory / 'fixture.json', 128 * 1024)), state)


def load_resource_policy_hash(state):
    """Match the JS importer's ASCII canonical deployment policy without secrets or process identities."""
    return digest(canonical({key: state[key] for key in ['commit', 'images', 'resourceLimits', 'loadPolicy']}))


def validate_pilot_admission(report, state):
    """Refuse an unmeasured or too-slow pilot; this is an additional guard, not a substitute for runtime proof."""
    require(isinstance(report, dict) and report.get('schemaVersion') == 1
        and report.get('namespace') == state['namespace']
        and report.get('experimentPolicyId') == state['experimentPolicyId']
        and report.get('policySha256') == state['experimentPolicySha256'] and report.get('runId') == state['runId']
        and report.get('workflow') == 'pilot' and report.get('status') == 'COMPLETE'
        and report.get('acceptance') == 'PILOT_PREPARED' and report.get('evidenceKind') == 'LIVE_NATIVE_ISOLATED'
        and report.get('corpusSha256') == state['loadPolicy']['pilotCorpusSha256']
        and report.get('familySha256') == state['loadPolicy']['familySha256'], 'load-live-pilot-report-required')
    load_policy_for_state(state)
    pilot = report.get('collections', {}).get('pilot', {})
    require(isinstance(pilot, dict) and pilot.get('collectionRole') == 'pilotA'
        and pilot.get('policySha256') == state['experimentPolicySha256'], 'load-pilot-collection-policy')
    elapsed = report.get('timing', {}).get('pilotIndexMs')
    proof = report.get('pilotObservation', {})
    require(type(elapsed) is int and elapsed > 0 and elapsed <= state['loadPolicy']['pilotSeconds'] * 1000
        and elapsed * (state['loadPolicy']['fullChildren'] // state['loadPolicy']['pilotChildren']) <= state['loadPolicy']['fullSeconds'] * 1000,
        'load-pilot-projection-exceeds-full-bound')
    require(proof.get('physicalChildren') == 2000 and proof.get('validatedNativeVectors') == 2000
        and type(proof.get('peakMemoryBytes')) is int and proof['peakMemoryBytes'] > 0
        and type(proof.get('minimumFreeBytes')) is int and proof['minimumFreeBytes'] >= state['loadPolicy']['minimumFreeBytes']
        and proof.get('modelWarmState') in {'WARM', 'COLD', 'UNKNOWN'}
        and proof.get('resourcePolicySha256') == load_resource_policy_hash(state)
        and proof.get('retries') == 0 and proof.get('errors') == 0, 'load-measured-pilot-prerequisite')


def validate_full_admission(report, state):
    """Admit traffic only after measured native 100k preparation; the runtime separately rechecks actual stores."""
    require(isinstance(report, dict) and report.get('schemaVersion') == 1
        and report.get('namespace') == state['namespace']
        and report.get('experimentPolicyId') == state['experimentPolicyId']
        and report.get('policySha256') == state['experimentPolicySha256'] and report.get('runId') == state['runId']
        and report.get('workflow') == 'full' and report.get('status') == 'COMPLETE'
        and report.get('acceptance') == 'FULL_INDEX_PREPARED' and report.get('evidenceKind') == 'LIVE_NATIVE_ISOLATED'
        and report.get('corpusSha256') == state['loadPolicy']['fullCorpusSha256']
        and report.get('familySha256') == state['loadPolicy']['familySha256'], 'load-live-full-report-required')
    require(all(isinstance(report.get(key), dict)
        for key in ['timing', 'fullObservation', 'collections', 'documents']), 'load-complete-full-prerequisite')
    load_policy_for_state(state)
    elapsed, proof = report.get('timing', {}).get('fullIndexMs'), report.get('fullObservation', {})
    primary, pilot = report.get('collections', {}).get('primary', {}), report.get('collections', {}).get('pilot', {})
    documents = report.get('documents', {}).get('loadA', [])
    require(isinstance(primary, dict) and isinstance(pilot, dict), 'load-complete-full-prerequisite')
    require(type(elapsed) is int and 0 < elapsed <= state['loadPolicy']['fullSeconds'] * 1000
        and isinstance(documents, list) and len(documents) == state['loadPolicy']['primaryDocuments']
        and all(isinstance(row, dict) and isinstance(row.get('documentId'), str)
            and re.fullmatch('[A-Za-z0-9_-]{1,128}', row['documentId']) for row in documents)
        and len({row['documentId'] for row in documents}) == state['loadPolicy']['primaryDocuments'],
        'load-complete-full-prerequisite')
    require(primary.get('collectionRole') == 'primaryA' and pilot.get('collectionRole') == 'pilotA'
        and all(collection.get('policySha256') == state['experimentPolicySha256'] for collection in [primary,pilot]),
        'load-full-collection-policy')
    require(all(isinstance(collection.get(key), str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', collection[key])
            for collection in [primary, pilot] for key in ['collectionId', 'generationId'])
        and primary['collectionId'] != pilot.get('collectionId')
        and primary['generationId'] != pilot.get('generationId')
        and pilot.get('activeChildren') == 2000 and pilot.get('parents') == 500
        and primary.get('activeChildren') == 100000 and primary.get('parents') == 25000
        and proof.get('physicalChildren') == 100000 and proof.get('parents') == 25000
        and proof.get('validatedNativeVectors') == 100000
        and type(proof.get('peakMemoryBytes')) is int and proof['peakMemoryBytes'] > 0
        and type(proof.get('minimumFreeBytes')) is int and proof['minimumFreeBytes'] >= state['loadPolicy']['minimumFreeBytes']
        and proof.get('modelWarmState') in {'WARM', 'COLD', 'UNKNOWN'}
        and proof.get('resourcePolicySha256') == load_resource_policy_hash(state)
        and proof.get('retries') == 0 and proof.get('errors') == 0
        and valid_hash(proof.get('manifestSha256')), 'load-measured-full-prerequisite')


def foreground_load(state, workflow):
    """Record the exact one-shot foreground caller before exec; history alone never proves native acceptance."""
    require(workflow in WORKFLOW_HISTORY, 'load-known-workflow')
    require(state['workflowHistory'] == WORKFLOW_HISTORY[workflow],
        'load-refuses-ambiguous-workflow-replay')
    require(state.get('loadProcess') is None or not process_alive(state, state['loadProcess']),
        'load-foreground-already-running')
    guard(state, 'import')
    free_space()
    if workflow == 'full':
        validate_pilot_admission(json.loads(read_private_bytes(state_path(state['runId'], state['experimentPolicyId']).parent /
            'load-pilot-report.json', 8 * 1024 ** 2)), state)
    if workflow == 'traffic':
        validate_full_admission(json.loads(read_private_bytes(state_path(state['runId'], state['experimentPolicyId']).parent /
            'load-full-report.json', 8 * 1024 ** 2)), state)
    filename = RUNTIME_ENTRIES[workflow]
    entry = HERE / filename
    require(entry.is_file() and not entry.is_symlink()
        and entry_digest(entry) == state['acceptanceSources'][filename],
        'load-existing-pinned-runtime-required')
    current = process_identity(os.getpid())
    require(current is not None, 'load-current-process-identity')
    state['loadProcess'] = {'pid': os.getpid(), 'startTicks': current['startTicks'],
        'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'entry': str(entry),
        'entrySha256': entry_digest(entry), 'cwd': str(ROOT), 'service': 'load', 'workflow': workflow}
    state['workflowHistory'].append(workflow)
    save(state)
    environment = {**base_environment(), **state['environment'],
        'VECTORIX_LOAD_RUN': state['runId'], 'VECTORIX_LOAD_ROLE': 'load'}
    arguments = [shutil.which('node'), str(entry), '--state', str(state_path(state['runId'], state['experimentPolicyId'])),
        '--run', state['runId'], '--mode', workflow]
    os.chdir(ROOT)
    os.execvpe(arguments[0], arguments, environment)


def app(state, service, workflow=None):
    require(service in {'api', 'workers', 'web', 'load'}, 'load-known-app')
    if service == 'load':
        return foreground_load(state, workflow)
    require(workflow is None, 'load-workflow-only-for-caller')
    require(state['phase'] in ({'SCHEMA_VERIFIED_EMPTY', 'BOOTSTRAPPING'} if service == 'api'
        else {'BOOTSTRAPPING', 'READY_FOR_LOAD_IMPORT', 'LOAD_WORKFLOW_COMPLETE', 'LOAD_WORKFLOW_INCOMPLETE'}),
        'load-app-phase')
    verify_pins(state)
    for name in SERVICES:
        owned(state, name, running=True)
    if service != 'api':
        validate_fixture(json.loads(read_private_bytes(state_path(state['runId'], state['experimentPolicyId']).parent / 'fixture.json', 128 * 1024)), state)
    target = state['dashboardProcesses'] if service == 'web' else state['processes']
    require(service not in target or not process_alive(state, target[service]), 'load-app-already-running')
    entry = Path(state['builds'][service]['entry'])
    require(all(not (entry.parent / name).exists() for name in ['.env', '.env.local', '.env.production', '.env.production.local']),
        'load-app-dotenv-refused')
    environment = {**base_environment(), **state['environment'], 'VECTORIX_LOAD_RUN': state['runId'], 'VECTORIX_LOAD_ROLE': service}
    arguments = [shutil.which('node')]
    if service != 'workers':
        free_port(state['ports'][service])
        environment.update(PORT=str(state['ports'][service]), HOSTNAME='127.0.0.1')
    if service == 'api':
        preload = state_path(state['runId'], state['experimentPolicyId']).parent / 'api-loopback.mjs'
        content = ("import net from 'node:net';const f=net.Server.prototype.listen;const p=" + str(state['ports']['api'])
            + ";net.Server.prototype.listen=function(...a){if(a[0]&&typeof a[0]==='object'&&Number(a[0].port)===p)a[0]={...a[0],host:'127.0.0.1'};else if(Number(a[0])===p){if(typeof a[1]==='string')a[1]='127.0.0.1';else a.splice(1,0,'127.0.0.1');}return f.apply(this,a);};\n")
        if preload.exists():
            require(read_private_bytes(preload, 4096) == content.encode(), 'load-loopback-preload-drift')
        else:
            descriptor = os.open(preload, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'w') as output:
                output.write(content)
        arguments += ['--import', str(preload)]
    current = process_identity(os.getpid())
    require(current is not None, 'load-current-process-identity')
    target[service] = {'pid': os.getpid(), 'startTicks': current['startTicks'],
        'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'entry': str(entry),
        'entrySha256': state['builds'][service]['entrySha256'], 'cwd': str(entry.parent), 'service': service}
    save(state)
    os.chdir(entry.parent)
    os.execvpe(arguments[0], arguments + [str(entry)], environment)


def ready(state):
    require(state['phase'] == 'BOOTSTRAPPING', 'load-ready-phase')
    validate_fixture(json.loads(read_private_bytes(state_path(state['runId'], state['experimentPolicyId']).parent / 'fixture.json', 128 * 1024)), state)
    for service in ['api', 'workers']:
        require(service in state['processes'] and process_alive(state, state['processes'][service]), 'load-live-runtime-required')
    state['phase'] = 'READY_FOR_LOAD_IMPORT'
    save(state)
    # A later explicit foreground workflow remains separately guarded; no model work starts here.


def cleanup(state):
    """Remove only new recorded fixture stores; model-cache removal is never implemented."""
    validate_state(state, state['runId'])
    stop_apps(state)
    state['phase'] = 'CLEANING'
    save(state)
    for service in [*reversed([name for name in SERVICES if name != 'ollama']), 'ollama']:
        saved = state['resources'].get(service)
        if saved is None:
            continue
        if saved['id'] is not None:
            value = owned(state, service)
            if value['State']['Running']:
                run(['docker', 'stop', '-t', '55', saved['id']], timeout=60)
            owned(state, service, running=False)
            run(['docker', 'rm', saved['id']], timeout=30)
            saved['id'] = None
            save(state)
        found = run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + saved['name'] + '$', '--format', '{{.ID}}'])
        require(not found.strip(), 'load-unrecorded-same-name-container')
        validate_volume(state, service, inspect(saved['volume'], 'volume'))
        if service != 'ollama':
            consumers = run(['docker', 'container', 'ls', '--all', '--filter', 'volume=' + saved['volume'], '--format', '{{.ID}}'])
            require(not consumers.strip(), 'load-unexpected-volume-consumer')
            run(['docker', 'volume', 'rm', saved['volume']], timeout=30)
        del state['resources'][service]
        save(state)
    state['phase'] = 'CLEANED_EVIDENCE_RETAINED'
    save(state)
    return {'runId': state['runId'], 'completed': True, 'phase': state['phase'], 'modelVolumePreserved': True,
        'privateEvidenceRetained': True, 'productRetentionAcceptance': False}


def lifecycle_status(state):
    """Describe lifecycle only; the independently validated private reports establish acceptance."""
    return {'runId': state['runId'], 'phase': state['phase'], 'resourceCount': len(state['resources']),
        'executionEnabled': not DRAFT_ONLY, 'acceptanceSource': 'PRIVATE_WORKFLOW_REPORTS'}


def main():
    require(not DRAFT_ONLY, 'load-topology-draft-awaiting-root-review')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--experiment', choices=['DEFAULT_V1','LIGHT_V1'], default='DEFAULT_V1')
    parser.add_argument('--mode', required=True, choices=['prepare', 'deploy', 'verify-schema', 'seed', 'app', 'ready',
        'guard', 'status', 'stop-apps', 'cleanup'])
    parser.add_argument('--purpose', choices=['bootstrap', 'bucket', 'import', 'dashboard'])
    parser.add_argument('--service', choices=['api', 'workers', 'web', 'load'])
    parser.add_argument('--workflow', choices=['pilot', 'full', 'traffic'])
    parser.add_argument('--model-volume')
    for service, image in IMAGES.items():
        parser.add_argument('--' + service + '-image', default=image)
    args = parser.parse_args()
    path = state_path(args.run, args.experiment)
    if args.mode == 'guard':
        private_directory(path.parent)
        print(json.dumps(guard(read_state(args.run, args.experiment), args.purpose, require_caller=args.purpose == 'import'), sort_keys=True))
        return
    if args.mode == 'prepare':
        CACHE.mkdir(parents=True, exist_ok=True)
        require(CACHE.resolve() == CACHE and CACHE.is_dir(), 'load-cache-path')
    with state_lock():
        if args.mode == 'prepare':
            state = prepare(args.run, args.model_volume, {service: getattr(args, service + '_image') for service in SERVICES}, args.experiment)
        else:
            private_directory(path.parent)
            state = read_state(args.run, args.experiment)
            if args.mode == 'deploy': deploy(state)
            elif args.mode == 'verify-schema': schema_ready(state)
            elif args.mode == 'seed': bootstrap(state)
            elif args.mode == 'app': app(state, args.service, args.workflow)
            elif args.mode == 'ready': ready(state)
            elif args.mode == 'cleanup':
                print(json.dumps(cleanup(state), sort_keys=True)); return
            elif args.mode == 'stop-apps': stop_apps(state)
        print(json.dumps(lifecycle_status(state), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        label = str(error) if isinstance(error, GuardError) and re.fullmatch('[a-z][a-z0-9-]{1,100}', str(error)) else 'load-sanitized-topology-failure'
        print(json.dumps({'completed': False, 'diagnostic': label}), file=sys.stderr)
        raise SystemExit(1) from None
