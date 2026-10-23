"""Guarded explicit lifecycle for one fresh local quality fixture; no work on import."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import quote

from quality_topology_policy import (ROOT, CACHE, NAMESPACE, SERVICES, DEFAULT_LIMITS,
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
PINNED_HELPERS = ['quality-topology.py', 'quality_topology_policy.py', 'quality-bootstrap.mjs',
    'quality-bootstrap-runtime.mjs', 'quality-bucket.mjs', 'collector.mjs', 'collector-runtime.mjs',
    'collector-state.mjs', 'collector-protocol.mjs', 'collector-guard.py', 'evaluate.mjs',
    'fixture-loader.mjs', 'queries.mjs', 'workspace-root.mjs']
PRODUCTION_PATHS = ['apps/api', 'apps/workers', 'apps/web', 'packages', 'pnpm-lock.yaml', 'package.json']
COLLECTOR_CHILD_DIAGNOSTICS = frozenset({
    'COLLECTOR_ARGUMENTS', 'COLLECTOR_EXACT_PRIVATE_STATE', 'COLLECTOR_WORKSPACE_NOT_FOUND',
    'COLLECTOR_PRIVATE_DIRECTORY', 'COLLECTOR_PRIVATE_FILE', 'COLLECTOR_PRIVATE_BYTE_CAP',
    'COLLECTOR_REFUSES_EXISTING_CAPTURE', 'COLLECTOR_INDEPENDENT_GUARD_REFUSED', 'COLLECTOR_GUARD_PROOF',
    'COLLECTOR_SYNTHETIC_AUTH_REFUSED', 'COLLECTOR_AUTH_IDENTITY', 'COLLECTOR_AUTH_OPERATION',
    'COLLECTOR_HTTP_DESTINATION', 'COLLECTOR_HTTP_REDIRECT', 'COLLECTOR_RESPONSE_DECLARED_CAP',
    'COLLECTOR_RESPONSE_ACTUAL_CAP', 'COLLECTOR_COOKIE_BOUND', 'COLLECTOR_RPC_OPERATION',
    'COLLECTOR_SANITIZED_REFUSAL', 'QUALITY_STATE_RUN', 'QUALITY_STATE_PHASE', 'QUALITY_TEST_DATABASES',
    'QUALITY_RELEASE_BINDING', 'QUALITY_RESOURCE_SET', 'QUALITY_PORT_SET', 'QUALITY_DISTINCT_PORTS',
    'QUALITY_HTTP_ORIGINS', 'QUALITY_RESOURCE_IDENTITY', 'QUALITY_VOLUME_NAME', 'QUALITY_NEW_STORE_VOLUME',
    'QUALITY_PRESERVED_MODEL_VOLUME', 'QUALITY_DISTINCT_RESOURCES', 'QUALITY_PRODUCTION_RUNTIME',
    'QUALITY_DATABASE_DSN', 'QUALITY_REDIS_DSN', 'QUALITY_ONLY_OWNED_OLLAMA', 'QUALITY_NO_HOSTED_PROVIDERS',
    'QUALITY_OWNED_OBJECT_STORAGE', 'QUALITY_RUNTIME_BOUNDARIES', 'QUALITY_REQUIRED_PROCESSES',
    'QUALITY_PROCESS_IDENTITY', 'BOOTSTRAP_BINDING', 'BOOTSTRAP_ROLES', 'BOOTSTRAP_ORGANIZATIONS',
    'BOOTSTRAP_USER_IDS', 'BOOTSTRAP_SYNTHETIC_CREDENTIALS', 'BOOTSTRAP_DISTINCT_USERS', 'BOOTSTRAP_MEMBERSHIPS',
})


def save(state):
    validate_state(state, state['runId'])
    save_json(state_path(state['runId']), state)


def inspect(name, kind='container'):
    value = json.loads(run(['docker', kind, 'inspect', name], timeout=10))
    require(isinstance(value, list) and len(value) == 1, 'quality-one-inspected-resource')
    return value[0]


def command_result(arguments, maximum=16384, timeout=10):
    return bounded_stream(arguments, capture=True, maximum=maximum, timeout=timeout, allowed_exit_codes=(0, 1))


def free_port(port=None):
    with socket.socket() as handle:
        handle.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            handle.bind(('127.0.0.1', port or 0))
        except OSError:
            raise GuardError('quality-loopback-port-unavailable') from None
        return handle.getsockname()[1]


def free_space():
    require(shutil.disk_usage(CACHE).free >= 4 * 1024 ** 3, 'quality-four-gib-free-required')


def migration_manifest():
    paths = sorted((ROOT / 'packages/db/prisma/migrations').glob('*/migration.sql'))
    require(1 <= len(paths) <= 64, 'quality-migration-chain-bound')
    return {path.parent.name: digest(path.read_bytes()) for path in paths}


def helper_manifest():
    result = {name: digest((HERE / name).read_bytes()) for name in PINNED_HELPERS}
    result['shared-restore-common.py'] = digest((ROOT / 'tests/acceptance/restore/m7c_restore_common.py').read_bytes())
    return result


def artifact_tree(directory):
    rows, total, visited, started = [], 0, 0, time.monotonic()
    for file in directory.rglob('*'):
        visited += 1
        require(visited <= 100000 and time.monotonic() - started <= 60, 'quality-artifact-enumeration-bound')
        relative = file.relative_to(directory).as_posix()
        if not file.is_file() or relative.startswith('.next/cache/') or '/.next/cache/' in relative:
            continue
        require(file.resolve().is_relative_to(ROOT) and file.name not in
            {'.env', '.env.local', '.env.production', '.env.production.local'}, 'quality-safe-artifact-tree')
        total += file.stat().st_size
        require(total <= 512 * 1024 ** 2 and len(rows) < 30000, 'quality-artifact-byte-bound')
        rows.append({'path': relative, 'bytes': file.stat().st_size, 'sha256': entry_digest(file)})
    require(rows, 'quality-nonempty-production-tree')
    return {'treeSha256': digest(canonical(sorted(rows, key=lambda value: value['path']))), 'treeFiles': len(rows)}


def build_manifest():
    entries = {}
    for service in ['api', 'workers', 'web']:
        entry = ROOT / ('apps/' + service + '/dist/index.mjs' if service != 'web'
            else 'apps/web/.next/standalone/apps/web/server.js')
        require(entry.is_file(), 'quality-existing-production-build-required')
        if service == 'web':
            require((entry.parent / '.next/static').is_dir() and (entry.parent / 'public').is_dir(),
                'quality-standalone-assets-required-before-pinning')
        entries[service] = {'entry': str(entry), 'entrySha256': entry_digest(entry), **artifact_tree(entry.parent)}
    return entries


def verify_pins(state):
    require(run(['git', 'rev-parse', 'HEAD']).decode().strip() == state['commit'], 'quality-head-drift')
    require(command_result(['git', 'diff', '--quiet', 'HEAD', '--', *PRODUCTION_PATHS])['exitCode'] == 0,
        'quality-dirty-production-source')
    require(digest((ROOT / 'pnpm-lock.yaml').read_bytes()) == state['lockfileSha256']
        and digest((ROOT / 'packages/db/prisma.config.ts').read_bytes()) == state['prismaConfigSha256']
        and migration_manifest() == state['migrations'] and helper_manifest() == state['acceptanceSources'],
        'quality-release-input-drift')
    manifest = json.loads((HERE / 'reference-v1/manifest.json').read_text())
    require(manifest['corpusDigest'] == state['corpusDigest'], 'quality-corpus-digest-drift')
    require(build_manifest() == state['builds'], 'quality-built-artifact-drift')


def owned(state, service, running=None):
    saved = state['resources'][service]
    require(saved['id'] is not None, 'quality-resource-without-recorded-container')
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
    require(value['uid'] == os.getuid() and value['cwd'] == saved['cwd'], 'quality-process-owner-cwd')
    exact = saved['entry'].encode() in value['command']
    next_entry = value['command'][0].startswith(b'next-server ') and saved['service'] == 'web'
    require(exact or next_entry, 'quality-process-command')
    expected = {'VECTORIX_QUALITY_RUN': state['runId'], 'VECTORIX_QUALITY_ROLE': saved['service']}
    for key, content in expected.items():
        matches = [item for item in value['environment'] if item.startswith(key.encode() + b'=')]
        require(matches == [(key + '=' + content).encode()], 'quality-process-run-markers')
    for key, content in state['environment'].items():
        require([item for item in value['environment'] if item.startswith(key.encode() + b'=')] ==
            [(key + '=' + content).encode()], 'quality-process-runtime-environment')
    if saved['service'] in {'api', 'web'}:
        require(('PORT=' + str(state['ports'][saved['service']])).encode() in value['environment'], 'quality-process-port')
    require(entry_digest(saved['entry']) == saved['entrySha256'], 'quality-process-entry-drift')
    return True


def process_records(state):
    records = [*state['processes'].values(), *state['dashboardProcesses'].values()]
    if state.get('collectorProcess'):
        records.append(state['collectorProcess'])
    return records


def stop_apps(state):
    records = process_records(state)
    for group in [[item for item in records if item['service'] == 'collector'],
                  [item for item in records if item['service'] != 'collector']]:
        for saved in group:
            if process_alive(state, saved):
                os.kill(saved['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 55
        while any(process_alive(state, saved) for saved in group):
            require(time.monotonic() < deadline, 'quality-graceful-app-stop-timeout')
            time.sleep(0.1)


def db_query(state, sql, *, service='postgres'):
    require(sql.lstrip().upper().startswith('SELECT') and len(sql) <= 16384, 'quality-readonly-query')
    resource = owned(state, service, running=True)
    database = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
    value = run(['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000',
        resource['Id'], 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', sql], timeout=20)
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        raise GuardError('quality-readonly-query-shape') from None


def assert_empty(state):
    result = db_query(state, '''SELECT json_build_object(
      'users',(SELECT count(*) FROM public."user"),'organizations',(SELECT count(*) FROM public.organization),
      'members',(SELECT count(*) FROM public.member),'roles',(SELECT count(*) FROM public."organizationRole"),
      'keys',(SELECT count(*) FROM public.apikey),'documents',(SELECT count(*) FROM public."Document"),
      'collections',(SELECT count(*) FROM public."Collection"))''')
    require(set(result) == {'users', 'organizations', 'members', 'roles', 'keys', 'documents', 'collections'}
        and all(type(value) is int and value == 0 for value in result.values()), 'quality-bootstrap-requires-empty-catalog')


def verify_schema(state):
    rows = db_query(state, '''SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,
      'complete',finished_at IS NOT NULL AND rolled_back_at IS NULL) ORDER BY migration_name),'[]'::json)
      FROM public."_prisma_migrations"''')
    require({row['name']: row['checksum'] for row in rows} == state['migrations'] and len(rows) == len(state['migrations'])
        and all(row['complete'] is True for row in rows), 'quality-approved-schema-not-fully-deployed')
    roles_sql = "SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_roles WHERE rolname !~ '^pg_'"
    require(db_query(state, roles_sql) == ['postgres'], 'quality-app-role-inventory')
    require(db_query(state, roles_sql, service='vector') == ['postgres', 'vectorix_indexer', 'vectorix_runtime'],
        'quality-vector-role-inventory')
    extensions = db_query(state, "SELECT json_object_agg(extname,extversion) FROM pg_extension", service='vector')
    require(extensions.get('vector') == '0.8.7' and extensions.get('vectorscale') == '0.9.1', 'quality-vector-extensions')
    roles = db_query(state, "SELECT to_json(bool_and(NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)) FROM pg_roles WHERE rolname IN ('vectorix_indexer','vectorix_runtime')", service='vector')
    require(roles is True, 'quality-vector-least-privilege')


def guard(state, purpose):
    """Read-only child preflight; intentionally does not reacquire the caller's lifecycle lock."""
    validate_state(state, state['runId'], complete=True)
    verify_pins(state)
    require(purpose in {'bootstrap', 'bucket', 'collect', 'dashboard'}, 'quality-guard-purpose')
    for service in SERVICES:
        owned(state, service, running=True)
    verify_schema(state)
    if purpose in {'bootstrap', 'bucket'}:
        require(state['phase'] in ({'SCHEMA_VERIFIED_EMPTY', 'BOOTSTRAPPING'} if purpose == 'bootstrap'
            else {'APP_DB_EMPTY_SCHEMA_REQUIRED'}), 'quality-guard-setup-phase')
        assert_empty(state)
        if purpose == 'bootstrap':
            require('api' in state['processes'] and process_alive(state, state['processes']['api']),
                'quality-bootstrap-owned-api-required')
    else:
        require(state['phase'] in {'READY_FOR_QUALITY_IMPORT', 'QUALITY_CAPTURE_COMPLETE', 'QUALITY_CAPTURE_INCOMPLETE'},
            'quality-guard-quality-phase')
        for service in ['api', 'workers']:
            require(service in state['processes'] and process_alive(state, state['processes'][service]),
                'quality-required-owned-runtime')
        validate_fixture(json.loads(read_private_bytes(state_path(state['runId']).parent / 'fixture.json', 128 * 1024)), state)
    return {'schemaVersion': 1, 'namespace': NAMESPACE, 'runId': state['runId'], 'purpose': purpose,
        'resourceOwnership': True, 'databaseReadOnly': True, 'bootstrapFreshness': purpose in {'bootstrap', 'bucket'}}


def initial_state(run_id, ports, images, model, builds, commit, *, limits=None):
    """Construct state from inspected inputs and bounded local source-pin reads."""
    secret = {key: secrets.token_urlsafe(24) for key in ['postgres', 'indexer', 'runtime', 's3Secret']}
    secret['s3Access'] = 'm7c-quality-' + run_id
    api, web = 'http://127.0.0.1:' + str(ports['api']), 'http://127.0.0.1:' + str(ports['web'])
    state = {'schemaVersion': 1, 'namespace': NAMESPACE, 'runId': run_id, 'prefix': NAMESPACE + '-' + run_id,
        'phase': 'PREPARING', 'ports': ports, 'images': images, 'resourceLimits': copy.deepcopy(limits or DEFAULT_LIMITS),
        'resources': {}, 'modelVolume': model, 'builds': builds, 'processes': {}, 'dashboardProcesses': {},
        'collectorProcess': None, 'infrastructureSecrets': secret, 'commit': commit,
        'lockfileSha256': digest((ROOT / 'pnpm-lock.yaml').read_bytes()),
        'prismaConfigSha256': digest((ROOT / 'packages/db/prisma.config.ts').read_bytes()),
        'migrations': migration_manifest(), 'acceptanceSources': helper_manifest(),
        'corpusDigest': json.loads((HERE / 'reference-v1/manifest.json').read_text())['corpusDigest'],
        'applicationDatabase': 'vectorix_m7c_quality_app_' + run_id + '_test',
        'vectorDatabase': 'vectorix_m7c_quality_vectors_' + run_id + '_test', 'apiOrigin': api, 'webOrigin': web}
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
        VECTORIX_DEFAULT_S3_BUCKET='m7c-quality-' + run_id, VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE='true',
        VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=secret['s3Access'], VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=secret['s3Secret'],
        VECTORIX_DEFAULT_OLLAMA_ENDPOINT='http://127.0.0.1:' + str(ports['ollama']),
        PASSKEY_RP_ID='127.0.0.1', PASSKEY_RP_NAME='Vectorix isolated quality acceptance', PASSKEY_ORIGINS=web)
    env['VECTORIX_S3_ALLOWED_ENDPOINTS'] = env['VECTORIX_DEFAULT_S3_ENDPOINT']
    env['VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS'] = env['VECTORIX_DEFAULT_OLLAMA_ENDPOINT']
    state['environment'] = env
    return validate_state(state, run_id)


def create_service(state, service):
    require(service not in state['resources'], 'quality-no-resource-overwrite')
    name = state['prefix'] + '-' + service
    container_names = run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'])
    require(not container_names.strip(), 'quality-existing-container-refused')
    if service == 'ollama':
        volume, identity = state['modelVolume']['name'], state['modelVolume']['identity']
    else:
        volume = name + '-data'
        require(command_result(['docker', 'volume', 'inspect', volume])['exitCode'] != 0, 'quality-existing-volume-refused')
        label_args = [item for key, value in labels(state['runId'], service).items() for item in ['--label', key + '=' + value]]
        run(['docker', 'volume', 'create', *label_args, volume])
        created = inspect(volume, 'volume')
        require(created['Name'] == volume and created['Driver'] == 'local' and created.get('Options') in [None, {}]
            and created.get('Labels') == labels(state['runId'], service), 'quality-new-volume-identity')
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
    for key, value in labels(state['runId'], service).items():
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
    require(valid_hash(identifier), 'quality-new-container-id')
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
            require(result.returncode in {0, 1, 2}, 'quality-postgres-readiness-command')
            if result.returncode == 0:
                return
            time.sleep(0.5)
        raise GuardError('quality-postgres-tcp-readiness')


def prepare(run_id, model_name, image_references):
    path = state_path(run_id)
    require(not path.parent.exists(), 'quality-fresh-run-directory-required')
    CACHE.mkdir(parents=True, exist_ok=True)
    require(CACHE.resolve() == CACHE and CACHE.is_dir(), 'quality-cache-path')
    free_space()
    require(model_name and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{1,127}', model_name), 'quality-explicit-model-volume-required')
    ports = {}
    for service in [*SERVICES, 'api', 'web', 'admin']:
        candidate = free_port()
        require(candidate not in ports.values(), 'quality-distinct-selected-ports')
        ports[service] = candidate
    images = {}
    for service, reference in image_references.items():
        require(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,255}', reference), 'quality-local-image-reference')
        value = inspect(reference, 'image')
        require(set(value['Config'].get('Volumes') or {}).issubset({SERVICES[service][1]}), 'quality-image-extra-volume')
        images[service] = value['Id']
    model = inspect(model_name, 'volume')
    require(model['Name'] == model_name and model['Driver'] == 'local' and model.get('Options') in [None, {}],
        'quality-existing-plain-model-volume')
    state = initial_state(run_id, ports, images, {'name': model_name, 'identity': volume_identity(model)}, build_manifest(),
        run(['git', 'rev-parse', 'HEAD']).decode().strip())
    verify_pins(state)
    path.parent.mkdir(mode=0o700)
    save_json(path, state, exclusive=True)
    for service in SERVICES:
        create_service(state, service)
    state['phase'] = 'APP_DB_EMPTY_SCHEMA_REQUIRED'
    save(state)
    return state


def deploy(state):
    require(state['phase'] == 'APP_DB_EMPTY_SCHEMA_REQUIRED' and not process_records(state), 'quality-deploy-empty-phase')
    verify_pins(state)
    for service in SERVICES:
        owned(state, service, running=True)
    directory = ROOT / 'packages/db'
    require(all(not (directory / name).exists() for name in ['.env', '.env.local', '.env.production', '.env.production.local']),
        'quality-prisma-dotenv-refused')
    binary = directory / 'node_modules/prisma/build/index.js'
    require(binary.is_file() and binary.resolve().is_relative_to(ROOT), 'quality-existing-prisma-cli')
    run([shutil.which('node'), str(binary), 'migrate', 'deploy', '--config', str(directory / 'prisma.config.ts')],
        environment={**base_environment(), 'DATABASE_URL': state['environment']['DATABASE_URL']}, directory=directory, timeout=120)
    verify_schema(state)
    assert_empty(state)


def child(state, filename, *, timeout=120):
    require(filename in {'quality-bootstrap.mjs', 'quality-bucket.mjs'}, 'quality-known-child')
    arguments = (['--run', state['runId']] if filename == 'quality-bootstrap.mjs'
        else ['--state', str(state_path(state['runId'])), '--run', state['runId']])
    result = bounded_stream([shutil.which('node'), str(HERE / filename), *arguments],
        environment={**base_environment(), **state['environment']}, capture=True, maximum=32768, timeout=timeout,
        allowed_exit_codes=(0, 1))
    try:
        value = json.loads(result['data'])
    except json.JSONDecodeError:
        raise GuardError('quality-child-response-shape') from None
    require(isinstance(value, dict) and result['exitCode'] == 0 and value.get('completed') is True
        and value.get('runId') == state['runId'], 'quality-child-refused')
    return value


def schema_ready(state):
    guard(state, 'bucket')
    child(state, 'quality-bucket.mjs')
    verify_schema(state)
    assert_empty(state)
    state['phase'] = 'SCHEMA_VERIFIED_EMPTY'
    save(state)


def bootstrap(state):
    require(state['phase'] == 'SCHEMA_VERIFIED_EMPTY', 'quality-bootstrap-phase')
    directory = state_path(state['runId']).parent
    require(not (directory / 'fixture.json').exists() and not (directory / 'bootstrap-progress.json').exists(),
        'quality-bootstrap-refuses-replay')
    guard(state, 'bootstrap')
    state['phase'] = 'BOOTSTRAPPING'
    save(state)
    child(state, 'quality-bootstrap.mjs', timeout=180)
    validate_fixture(json.loads(read_private_bytes(directory / 'fixture.json', 128 * 1024)), state)


def app(state, service):
    require(service in {'api', 'workers', 'web'}, 'quality-known-app')
    require(state['phase'] in ({'SCHEMA_VERIFIED_EMPTY', 'BOOTSTRAPPING'} if service == 'api'
        else {'BOOTSTRAPPING', 'READY_FOR_QUALITY_IMPORT', 'QUALITY_CAPTURE_COMPLETE', 'QUALITY_CAPTURE_INCOMPLETE'}),
        'quality-app-phase')
    verify_pins(state)
    for name in SERVICES:
        owned(state, name, running=True)
    if service != 'api':
        validate_fixture(json.loads(read_private_bytes(state_path(state['runId']).parent / 'fixture.json', 128 * 1024)), state)
    target = state['dashboardProcesses'] if service == 'web' else state['processes']
    require(service not in target or not process_alive(state, target[service]), 'quality-app-already-running')
    entry = Path(state['builds'][service]['entry'])
    require(all(not (entry.parent / name).exists() for name in ['.env', '.env.local', '.env.production', '.env.production.local']),
        'quality-app-dotenv-refused')
    environment = {**base_environment(), **state['environment'], 'VECTORIX_QUALITY_RUN': state['runId'], 'VECTORIX_QUALITY_ROLE': service}
    arguments = [shutil.which('node')]
    if service != 'workers':
        free_port(state['ports'][service])
        environment.update(PORT=str(state['ports'][service]), HOSTNAME='127.0.0.1')
    if service == 'api':
        preload = state_path(state['runId']).parent / 'api-loopback.mjs'
        content = ("import net from 'node:net';const f=net.Server.prototype.listen;const p=" + str(state['ports']['api'])
            + ";net.Server.prototype.listen=function(...a){if(a[0]&&typeof a[0]==='object'&&Number(a[0].port)===p)a[0]={...a[0],host:'127.0.0.1'};else if(Number(a[0])===p){if(typeof a[1]==='string')a[1]='127.0.0.1';else a.splice(1,0,'127.0.0.1');}return f.apply(this,a);};\n")
        if preload.exists():
            require(read_private_bytes(preload, 4096) == content.encode(), 'quality-loopback-preload-drift')
        else:
            descriptor = os.open(preload, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'w') as output:
                output.write(content)
        arguments += ['--import', str(preload)]
    current = process_identity(os.getpid())
    require(current is not None, 'quality-current-process-identity')
    target[service] = {'pid': os.getpid(), 'startTicks': current['startTicks'],
        'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'entry': str(entry),
        'entrySha256': state['builds'][service]['entrySha256'], 'cwd': str(entry.parent), 'service': service}
    save(state)
    os.chdir(entry.parent)
    os.execvpe(arguments[0], arguments + [str(entry)], environment)


def ready(state):
    require(state['phase'] == 'BOOTSTRAPPING', 'quality-ready-phase')
    validate_fixture(json.loads(read_private_bytes(state_path(state['runId']).parent / 'fixture.json', 128 * 1024)), state)
    for service in ['api', 'workers']:
        require(service in state['processes'] and process_alive(state, state['processes'][service]), 'quality-live-runtime-required')
    state['phase'] = 'READY_FOR_QUALITY_IMPORT'
    save(state)
    # The independent existing collector guard remains a separate admission.


def collector_outcome(run_id, exit_code, stdout, stderr):
    """Project bounded child output to fixed labels only; raw streams never enter the private proof."""
    require(re.fullmatch('[a-f0-9]{12}', run_id) is not None, 'quality-collector-proof-run')
    require(type(exit_code) is int and -64 <= exit_code <= 255, 'quality-collector-proof-exit')
    require(isinstance(stdout, (bytes, bytearray)) and isinstance(stderr, (bytes, bytearray))
        and len(stdout) <= 32768 and len(stderr) <= 32768, 'quality-collector-proof-stream-bound')
    summary, error = None, None
    try:
        summary = json.loads(stdout)
    except (ValueError, UnicodeError, RecursionError):
        pass
    if len(stderr) <= 4096:
        try:
            candidate = json.loads(stderr)
            if isinstance(candidate, dict) and set(candidate) == {'completed', 'status', 'diagnostic'} \
                    and candidate['completed'] is False and candidate['status'] == 'NOT_RUN_OR_INCOMPLETE' \
                    and isinstance(candidate['diagnostic'], str) and candidate['diagnostic'] in COLLECTOR_CHILD_DIAGNOSTICS:
                error = candidate['diagnostic']
        except (ValueError, UnicodeError, RecursionError):
            pass
    passed = exit_code == 0 and isinstance(summary, dict) and summary.get('runId') == run_id \
        and summary.get('status') == 'PASS' and summary.get('observedQueryCells') == 720 \
        and summary.get('sourceProofs') == 72
    proof = {'schemaVersion': 1, 'namespace': NAMESPACE, 'runId': run_id, 'childExitCode': exit_code,
        'result': 'PASSED' if passed else 'DID_NOT_PASS', 'diagnostic': error or 'UNAVAILABLE',
        'stdoutBytes': len(stdout), 'stderrBytes': len(stderr)}
    require(len(canonical(proof)) <= 4096, 'quality-collector-proof-byte-bound')
    return proof


def supervise_collector(state):
    """Bound the long collector independently; never relax shared short-command limits."""
    guard(state, 'collect')
    free_space()
    directory = state_path(state['runId']).parent
    require(not any((directory / name).exists() for name in ['capture.partial.json', 'capture.json', 'quality-report.json',
        'collector-outcome.json']),
        'quality-refuses-existing-capture')
    require(state.get('collectorProcess') is None or not process_alive(state, state['collectorProcess']),
        'quality-collector-already-running')
    entry = HERE / 'collector.mjs'
    environment = {**base_environment(), **state['environment'], 'VECTORIX_QUALITY_RUN': state['runId'], 'VECTORIX_QUALITY_ROLE': 'collector'}
    process = subprocess.Popen([shutil.which('node'), str(entry), '--state', str(state_path(state['runId'])), '--run', state['runId']],
        cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector, output = selectors.DefaultSelector(), {'stdout': bytearray(), 'stderr': bytearray()}
    started = time.monotonic()
    try:
        identity = process_identity(process.pid)
        require(identity is not None, 'quality-collector-started-process')
        state['collectorProcess'] = {'pid': process.pid, 'startTicks': identity['startTicks'],
            'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'entry': str(entry),
            'entrySha256': entry_digest(entry), 'cwd': str(ROOT), 'service': 'collector'}
        state['collectorStatus'] = 'RUNNING'
        save(state)
        selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
        while selector.get_map():
            require(time.monotonic() - started <= 90 * 60 + 120, 'quality-collector-total-deadline')
            for key, _ in selector.select(timeout=0.25):
                part = os.read(key.fd, 4096)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    output[key.data].extend(part)
                    require(len(output[key.data]) <= 32768, 'quality-collector-output-cap')
        result = process.wait(timeout=5)
        proof = collector_outcome(state['runId'], result, output['stdout'], output['stderr'])
        save_json(directory / 'collector-outcome.json', proof, exclusive=True)
        require(proof['result'] == 'PASSED', 'quality-collector-not-passed')
        summary = json.loads(output['stdout'])
        state['phase'], state['collectorStatus'] = 'QUALITY_CAPTURE_COMPLETE', 'PASS'
        save(state)
        return summary
    except BaseException:
        state['phase'], state['collectorStatus'] = 'QUALITY_CAPTURE_INCOMPLETE', 'INCOMPLETE'
        save(state)
        raise
    finally:
        selector.close()
        for handle in [process.stdout, process.stderr]:
            handle.close()
        if process.poll() is None:
            # This unreaped Popen child cannot have a recycled PID, including
            # the narrow failure before its /proc identity was checkpointed.
            process.terminate()
            try:
                process.wait(timeout=55)
            except subprocess.TimeoutExpired:
                raise GuardError('quality-collector-graceful-stop-timeout') from None


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
        require(not found.strip(), 'quality-unrecorded-same-name-container')
        validate_volume(state, service, inspect(saved['volume'], 'volume'))
        if service != 'ollama':
            consumers = run(['docker', 'container', 'ls', '--all', '--filter', 'volume=' + saved['volume'], '--format', '{{.ID}}'])
            require(not consumers.strip(), 'quality-unexpected-volume-consumer')
            run(['docker', 'volume', 'rm', saved['volume']], timeout=30)
        del state['resources'][service]
        save(state)
    state['phase'] = 'CLEANED_EVIDENCE_RETAINED'
    save(state)
    return {'runId': state['runId'], 'completed': True, 'phase': state['phase'], 'modelVolumePreserved': True,
        'privateEvidenceRetained': True, 'productRetentionAcceptance': False}


def main():
    require(not DRAFT_ONLY, 'quality-topology-draft-awaiting-root-review')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--mode', required=True, choices=['prepare', 'deploy', 'verify-schema', 'seed', 'app', 'ready',
        'guard', 'collect', 'status', 'stop-apps', 'cleanup'])
    parser.add_argument('--purpose', choices=['bootstrap', 'bucket', 'collect', 'dashboard'])
    parser.add_argument('--service', choices=['api', 'workers', 'web'])
    parser.add_argument('--model-volume')
    for service, image in IMAGES.items():
        parser.add_argument('--' + service + '-image', default=image)
    args = parser.parse_args()
    path = state_path(args.run)
    if args.mode == 'guard':
        private_directory(path.parent)
        print(json.dumps(guard(read_state(args.run), args.purpose), sort_keys=True))
        return
    if args.mode == 'prepare':
        CACHE.mkdir(parents=True, exist_ok=True)
        require(CACHE.resolve() == CACHE and CACHE.is_dir(), 'quality-cache-path')
    with state_lock():
        if args.mode == 'prepare':
            state = prepare(args.run, args.model_volume, {service: getattr(args, service + '_image') for service in SERVICES})
        else:
            private_directory(path.parent)
            state = read_state(args.run)
            if args.mode == 'deploy': deploy(state)
            elif args.mode == 'verify-schema': schema_ready(state)
            elif args.mode == 'seed': bootstrap(state)
            elif args.mode == 'app': app(state, args.service)
            elif args.mode == 'ready': ready(state)
            elif args.mode == 'collect':
                print(json.dumps(supervise_collector(state), sort_keys=True)); return
            elif args.mode == 'cleanup':
                print(json.dumps(cleanup(state), sort_keys=True)); return
            elif args.mode == 'stop-apps': stop_apps(state)
        print(json.dumps({'runId': state['runId'], 'phase': state['phase'], 'resourceCount': len(state['resources']),
            'draftAcceptance': False, 'qualityAcceptance': state.get('collectorStatus', 'NOT_RUN'),
            'capacityAcceptance': 'NOT_RUN'}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        label = str(error) if isinstance(error, GuardError) and re.fullmatch('[a-z][a-z0-9-]{1,100}', str(error)) else 'quality-sanitized-topology-failure'
        print(json.dumps({'completed': False, 'diagnostic': label}), file=sys.stderr)
        raise SystemExit(1) from None
