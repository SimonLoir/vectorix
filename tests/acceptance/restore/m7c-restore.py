"""Explicitly invoked owned M7c full-store acceptance. Static preparation is not acceptance."""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

from m7c_restore_common import (
    APP_PORTS, CACHE, MAX_DUMP, ROOT, SERVICES, GuardError, base_environment,
    bounded_stream, canonical, database_command, digest, labels, metadata, no_apps,
    owned_container, owned_model, owned_volume, open_private, private_directory, private_file, process_alive, process_identity,
    read_json, read_private_bytes, require, run, save_json, state_lock, state_path, stop_apps, validate_state, volume_identity,
)
from m7c_restore_proof import fixture, public_snapshot, role_manifest, snapshot
from m7c_restore_archive import MAX_ROLES, reviewed_role_import

IMAGES = {
    'postgres': 'postgres:18-alpine', 'vector': 'pxdv.be/vectorix/postgres-vector:local',
    'redis': 'redis:8-alpine',
    'rustfs': 'rustfs/rustfs:1.0.3@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b',
    'ollama': 'ollama/ollama:0.40.8',
}
STATIC_DRAFT_ONLY = False  # Guarded operator invocation enabled after independent static review.


def save(path, state):
    save_json(path, state)


def wait_ready(check, label):
    deadline = time.monotonic() + 55
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (GuardError, subprocess.TimeoutExpired):
            pass
        time.sleep(0.5)
    raise GuardError(label)


def free_port(port=None):
    with socket.socket() as handle:
        # Match Docker's listener reuse after owned shutdown: TIME_WAIT is not a live listener.
        # SO_REUSEPORT is deliberately absent, so an active listener still prevents binding.
        handle.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            handle.bind(('127.0.0.1', port or 0))
        except OSError:
            raise GuardError('loopback-port-unavailable') from None
        return handle.getsockname()[1]


def service_values(state, service, side):
    secret = state['infrastructureSecrets']
    if service in ['postgres', 'vector']:
        actual = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
        values = {'POSTGRES_PASSWORD': secret['postgres'],
                  'POSTGRES_DB': actual if side == 'source' else state['bootstrapDatabase']}
        if service == 'vector':
            values.update(VECTOR_PROVISIONER_PASSWORD=secret['indexer'], VECTOR_RUNTIME_PASSWORD=secret['runtime'])
        return values
    if service == 'rustfs':
        return {'RUSTFS_ACCESS_KEY': secret['s3Access'], 'RUSTFS_SECRET_KEY': secret['s3Secret'],
                'RUSTFS_REGION': 'us-east-1', 'RUSTFS_CONSOLE_ENABLE': 'false', 'RUSTFS_OBS_LOG_DIRECTORY': '/tmp/logs'}
    return {}


def create_service(path, state, side, service):
    require(service not in state['resources'][side], 'no-resource-overwrite')
    container = state['prefix'] + '-' + side + '-' + service
    volume = container + '-data'
    resource_labels = labels(state, side, service)
    label_arguments = [item for key, value in resource_labels.items() for item in ['--label', key + '=' + value]]
    # Docker create refuses an existing name. Volume create is idempotent, so explicitly reject first.
    existing = subprocess.run(['docker', 'volume', 'inspect', volume], env=base_environment(),
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    require(existing.returncode != 0, 'volume-must-be-new')
    run(['docker', 'volume', 'create', *label_arguments, volume])
    created = metadata(volume, 'volume')
    state['resources'][side][service] = {'volume': volume, 'volumeIdentity': volume_identity(created), 'id': None}
    save(path, state)  # Recoverable ownership record even if container creation fails.
    values = service_values(state, service, side)
    arguments = ['docker', 'run', '--pull=never', '-d', '--name', container, '--network=bridge',
                 *label_arguments, '--mount', 'type=volume,src=' + volume + ',dst=' + SERVICES[service]['mount'],
                 '-p', '127.0.0.1:' + str(state['ports'][service]) + ':' + str(SERVICES[service]['port'])]
    for key in values:
        arguments += ['-e', key]
    arguments += [state['images'][service]]
    if service == 'rustfs':
        arguments += ['/data']
    identifier = run(arguments, environment={**base_environment(), **values}, timeout=55).decode().strip()
    require(len(identifier) == 64 and all(char in 'abcdef0123456789' for char in identifier), 'new-container-id')
    state['resources'][side][service]['id'] = identifier
    save(path, state)
    owned_container(state, side, service, running=True)
    if service in ['postgres', 'vector']:
        database = state['bootstrapDatabase'] if side == 'target' else state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
        wait_ready(lambda: run(['docker', 'exec', identifier, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database], timeout=5), 'postgres-readiness')


def runtime_tree(directory):
    """Pin built outputs, excluding only runtime caches; dependencies stay at the recorded frozen lock."""
    rows, total, visited, started = [], 0, 0, time.monotonic()
    for entry in directory.rglob('*'):
        visited += 1
        require(visited <= 100000 and time.monotonic() - started < 60, 'bounded-production-artifact-enumeration')
        require(not entry.is_symlink() or entry.resolve().is_relative_to(ROOT), 'runtime-symlink-outside-workspace')
        if not entry.is_file() or '.next/cache' in entry.relative_to(directory).as_posix():
            continue
        require(entry.resolve().is_relative_to(ROOT), 'built-artifact-outside-workspace')
        require(entry.name not in ['.env', '.env.local', '.env.production', '.env.production.local'], 'dotenv-in-runtime-tree')
        total += entry.stat().st_size
        require(total <= 512 * 1024 * 1024 and len(rows) < 30000 and time.monotonic() - started < 60, 'bounded-production-artifact-tree')
        rows.append({'path': entry.relative_to(directory).as_posix(), 'bytes': entry.stat().st_size, 'sha256': digest(entry.read_bytes())})
    return {'files': len(rows), 'bytes': total, 'sha256': digest(canonical(sorted(rows, key=lambda value: value['path'])))}


def built_entries():
    result = {}
    for service in ['api', 'workers', 'web', 'admin']:
        entry = ROOT / ('apps/' + service + '/dist/index.mjs' if service in ['api', 'workers']
                        else 'apps/' + service + '/.next/standalone/apps/' + service + '/server.js')
        require(entry.is_file(), 'existing-production-build-required')
        result[service] = {'entry': str(entry), 'sha256': digest(entry.read_bytes()), 'tree': runtime_tree(entry.parent)}
    return result


def migration_manifest():
    paths = sorted((ROOT / 'packages/db/prisma/migrations').glob('*/migration.sql'))
    require(1 <= len(paths) <= 64, 'bounded-approved-migration-chain')
    return {file.parent.name: digest(file.read_bytes()) for file in paths}


def free_space():
    """Conservative fixture refusal, not a production capacity estimate."""
    require(shutil.disk_usage(CACHE).free >= 4 * 1024 * 1024 * 1024, 'fixture-requires-four-gib-free')


def prepare(path, run_id, model_volume, image_references):
    free_space()
    require(not path.parent.exists(), 'fresh-run-directory')
    require(model_volume and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{1,127}', model_volume) is not None
            and not model_volume.startswith('vectorix-m7c-restore-'), 'explicit-existing-model-volume-required')
    no_apps({'processes': {}})
    secret = {key: secrets.token_urlsafe(24) for key in ['postgres', 'indexer', 'runtime', 's3Secret']}
    secret['s3Access'] = 'm7c-' + run_id
    ports = {}
    for service in [*SERVICES, 'ollama']:
        candidate = free_port()
        require(candidate not in ports.values() and candidate not in APP_PORTS.values(), 'distinct-new-ports')
        ports[service] = candidate
    image_metadata = {key: json.loads(run(['docker', 'image', 'inspect', value]))[0] for key, value in image_references.items()}
    images = {key: value['Id'] for key, value in image_metadata.items()}
    for value in images.values():
        require(value.startswith('sha256:') and len(value) == 71, 'local-image-identity')
    for service, value in image_metadata.items():
        expected_mount = '/root/.ollama' if service == 'ollama' else SERVICES[service]['mount']
        require(set(value['Config'].get('Volumes') or {}).issubset({expected_mount}), 'unsupported-image-declared-volume')
    model = metadata(model_volume, 'volume')
    require(model['Name'] == model_volume and model['Driver'] == 'local' and model.get('Options') in [None, {}], 'preexisting-plain-local-model-volume')
    for service in ['web', 'admin']:
        destination = ROOT / ('apps/' + service + '/.next/standalone/apps/' + service)
        require(destination.is_dir(), 'existing-standalone-build-required')
        shutil.copytree(ROOT / ('apps/' + service + '/.next/static'), destination / '.next/static', dirs_exist_ok=True)
        public = ROOT / ('apps/' + service + '/public')
        if public.exists():
            shutil.copytree(public, destination / 'public', dirs_exist_ok=True)
    state = {'version': 1, 'runId': run_id, 'prefix': 'vectorix-m7c-restore-' + run_id,
             'phase': 'preparing-source', 'resources': {'source': {}, 'target': {}}, 'processes': {},
             'images': images, 'ports': ports, 'infrastructureSecrets': secret,
             'applicationDatabase': 'vectorix_m7c_app_' + run_id + '_test',
             'vectorDatabase': 'vectorix_m7c_vectors_' + run_id + '_test',
             'bootstrapDatabase': 'vectorix_m7c_bootstrap_' + run_id + '_test',
             'buckets': ['m7c-' + run_id + '-platform', 'm7c-' + run_id + '-organization'],
             'modelVolume': {'name': model_volume, 'identity': volume_identity(model)}, 'builds': built_entries(),
             'migrations': migration_manifest(), 'lockfileSha256': digest((ROOT / 'pnpm-lock.yaml').read_bytes()),
             'prismaConfigSha256': digest((ROOT / 'packages/db/prisma.config.ts').read_bytes()),
             'commit': run(['git', 'rev-parse', 'HEAD']).decode().strip()}
    endpoint = 'http://127.0.0.1:' + str(ports['rustfs'])
    embedding = 'http://127.0.0.1:' + str(ports['ollama'])
    state['environment'] = {
        'NODE_ENV': 'production', 'TZ': 'UTC',
        'DATABASE_URL': 'postgresql://postgres:' + quote(secret['postgres'], safe='') + '@127.0.0.1:' + str(ports['postgres']) + '/' + state['applicationDatabase'],
        'VECTOR_DATABASE_URL': 'postgresql://vectorix_runtime:' + quote(secret['runtime'], safe='') + '@127.0.0.1:' + str(ports['vector']) + '/' + state['vectorDatabase'],
        'VECTOR_DATABASE_PROVISIONING_URL': 'postgresql://vectorix_indexer:' + quote(secret['indexer'], safe='') + '@127.0.0.1:' + str(ports['vector']) + '/' + state['vectorDatabase'],
        'VECTOR_DATABASE_SCHEMA': 'vector_collections', 'REDIS_URL': 'redis://127.0.0.1:' + str(ports['redis']),
        'BETTER_AUTH_SECRET': secrets.token_urlsafe(48), 'ENCRYPTION_SECRET': secrets.token_hex(32),
        'BETTER_AUTH_URL': 'http://localhost:3101', 'API_URL': 'http://localhost:3101',
        'VECTORIX_WEB_URL': 'http://localhost:3100', 'TRUSTED_ORIGINS': 'http://localhost:3100,http://localhost:3006',
        'ALLOW_ACCOUNT_CREATION': 'true', 'ALLOW_ORGANIZATION_CREATION': 'true', 'ROOT_DOMAIN': '',
        'BETTER_AUTH_COOKIE_NAME': '', 'BETTER_AUTH_COOKIE_PREFIX': '', 'VECTORIX_TIME_ZONE': 'UTC',
        'VECTORIX_FEATURE_PROVIDER_URL': '', 'VECTORIX_DEFAULT_RESEND_API_KEY': '',
        'VECTORIX_DEFAULT_SMTP_HOST': '', 'VECTORIX_WEB_PUSH_ENABLED': 'false',
        'VECTORIX_DEFAULT_S3_ENDPOINT': endpoint, 'VECTORIX_DEFAULT_S3_REGION': 'us-east-1',
        'VECTORIX_DEFAULT_S3_BUCKET': state['buckets'][0], 'VECTORIX_DEFAULT_S3_ACCESS_KEY_ID': secret['s3Access'],
        'VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY': secret['s3Secret'], 'VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE': 'true',
        'VECTORIX_S3_ALLOWED_ENDPOINTS': endpoint, 'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS': embedding,
        'VECTORIX_DEFAULT_OLLAMA_ENDPOINT': embedding, 'VECTORIX_DEFAULT_OLLAMA_API_KEY': '',
        'VECTORIX_DEFAULT_COHERE_API_KEY': '', 'VECTORIX_DEFAULT_VOYAGE_API_KEY': '',
        'VECTORIX_DEFAULT_OPENAI_API_KEY': '', 'VECTORIX_DEFAULT_MISTRAL_API_KEY': '',
        'PASSKEY_RP_ID': 'localhost', 'PASSKEY_RP_NAME': 'Vectorix isolated restore acceptance',
        'PASSKEY_ORIGINS': 'http://localhost:3100,http://localhost:3006',
    }
    validate_state(state, run_id)
    path.parent.mkdir(mode=0o700)
    save_json(path, state, exclusive=True)
    for service in SERVICES:
        create_service(path, state, 'source', service)
    model_name = state['prefix'] + '-ollama'
    model_id = run(['docker', 'run', '--pull=never', '-d', '--name', model_name,
                    '--label', 'vectorix.restore-test.id=' + run_id, '--label', 'vectorix.restore-test.service=ollama',
                    '--label', 'vectorix.restore-test.side=shared',
                    '--network=bridge', '--cpus=2', '--memory=3g',
                    '--mount', 'type=volume,src=' + model_volume + ',dst=/root/.ollama,readonly',
                    '-p', '127.0.0.1:' + str(ports['ollama']) + ':11434',
                    '-e', 'OLLAMA_HOST=0.0.0.0:11434', '-e', 'OLLAMA_NUM_PARALLEL=1', images['ollama']], timeout=55).decode().strip()
    state['modelContainer'] = {'name': model_name, 'id': model_id}
    save(path, state)
    owned_model(state, running=True)
    state['phase'] = 'source-empty-approved-schema-setup-required'
    save(path, state)
    return {'runId': run_id, 'phase': state['phase'], 'privateState': str(path), 'ports': ports,
            'note': 'No migration or generation ran. The explicit approved-source deployment mode is a separate step.'}


def object_step(state, path, mode):
    for service in SERVICES:
        owned_container(state, 'source' if mode in ['initialize-source', 'export', 'verify-source'] else 'target', service, running=True)
    command = [shutil.which('node'), str(Path(__file__).with_name('m7c-objects.mjs')), '--state', str(path), '--run', state['runId'], '--mode', mode]
    result = bounded_stream(command, maximum=16384, timeout=180, capture=True, allowed_exit_codes=(0, 1))
    try:
        response = json.loads(result['data'])
    except json.JSONDecodeError:
        raise GuardError('object-child-response-shape') from None
    require(isinstance(response, dict), 'object-child-response-shape')
    if response.get('completed') is False:
        diagnostic = response.get('diagnostic', '')
        label = diagnostic if isinstance(diagnostic, str) and re.fullmatch('[a-z][a-z0-9-]{0,100}', diagnostic) else 'sanitized-object-step-failure'
        raise GuardError('object-child-' + label)
    require(result['exitCode'] == 0 and response.get('formatVersion') == 1, 'object-child-success-protocol')
    return response


def deploy_approved_source_schema(path, state):
    """Explicitly deploy only the pinned, already-reviewed chain to the new source test DB."""
    require(state['phase'] == 'source-empty-approved-schema-setup-required', 'source-deploy-phase')
    no_apps(state)
    require(migration_manifest() == state['migrations'], 'approved-migration-chain-drift')
    require(digest((ROOT / 'pnpm-lock.yaml').read_bytes()) == state['lockfileSha256'], 'source-deploy-lockfile-drift')
    for service in SERVICES:
        owned_container(state, 'source', service, running=True)
    require(not state['resources']['target'], 'source-deploy-no-target')
    directory = ROOT / 'packages/db'
    for filename in ['.env', '.env.local', '.env.production', '.env.production.local']:
        require(not (directory / filename).exists(), 'source-deploy-local-dotenv-refused')
    require(digest((directory / 'prisma.config.ts').read_bytes()) == state['prismaConfigSha256'], 'source-deploy-config-drift')
    binary = directory / 'node_modules/prisma/build/index.js'
    require(binary.resolve().is_relative_to(ROOT) and binary.is_file(), 'existing-prisma-cli-required')
    environment = {**base_environment(), 'DATABASE_URL': state['environment']['DATABASE_URL']}
    run([shutil.which('node'), str(binary), 'migrate', 'deploy', '--config', str(directory / 'prisma.config.ts')], environment=environment, directory=directory, timeout=60)
    # source-ready separately verifies exact DB checksums; this mode never generates or edits SQL.
    return {'phase': state['phase'], 'approvedSourceDeploymentCommandCompleted': True,
            'schemaGenerated': False, 'targetModified': False}


def source_ready(path, state):
    require(state['phase'] == 'source-empty-approved-schema-setup-required', 'source-initialization-phase')
    require(migration_manifest() == state['migrations'], 'approved-migration-chain-drift')
    from m7c_restore_common import sql_json
    rows = sql_json(state, 'source', 'postgres', '''SELECT coalesce(json_agg(json_build_object(
       'name',migration_name,'checksum',checksum,'complete',finished_at IS NOT NULL AND rolled_back_at IS NULL)
       ORDER BY migration_name),'[]'::json) FROM "_prisma_migrations"''')
    require({row['name']: row['checksum'] for row in rows} == state['migrations'] and all(row['complete'] for row in rows), 'existing-approved-migrations-not-fully-deployed')
    object_step(state, path, 'initialize-source')
    state['phase'] = 'source-available-for-approved-dashboard-setup'
    save(path, state)
    return {'phase': state['phase'], 'approvedMigrationChecksumsVerified': True, 'schemaGenerated': False}


def seed(path, state):
    require(state['phase'] == 'source-available-for-approved-dashboard-setup', 'seed-source-phase')
    require(not (path.parent / 'fixture.json').exists(), 'seed-refuses-existing-fixture')
    for service in SERVICES:
        owned_container(state, 'source', service, running=True)
    owned_model(state, running=True)
    api = state['processes'].get('api')
    require(api and api['side'] == 'source' and api['runId'] == state['runId']
            and api['entry'] == state['builds']['api']['entry'] and process_alive(api), 'seed-owned-source-api-required')
    require(built_entries() == state['builds'], 'seed-current-production-builds')
    environment = {**state['environment'], 'PATH': os.environ['PATH'],
                   'VECTORIX_RESTORE_RUN': state['runId'], 'VECTORIX_RESTORE_SIDE': 'source'}
    result = json.loads(run([shutil.which('node'), '--import', 'tsx', str(Path(__file__).with_name('m7c-seed.mjs')), state['runId']],
                            environment=environment, directory=ROOT / 'apps/api', timeout=60))
    require(result['runId'] == state['runId'] and len(result['organizationIds']) == 2, 'seed-safe-result')
    created = read_json(path.parent / 'fixture.json')
    require(created['runId'] == state['runId'] and created['prefix'] == state['prefix']
            and len(created['organizationIds']) == 2 and len(created['userIds']) == 4, 'seed-private-fixture-written')
    return {'runId': state['runId'], 'seededOrganizations': 2, 'seededUsers': 4,
            'privateFixture': str(path.parent / 'fixture.json'), 'dashboardDocumentsCreated': False}


def app(path, state, side, service):
    expected = ['source-available-for-approved-dashboard-setup'] if side == 'source' else ['restored-verified-before-replay', 'target-acceptance-running']
    require(state['phase'] in expected, 'app-start-phase')
    for name in SERVICES:
        owned_container(state, side, name, running=True)
    require(built_entries() == state['builds'], 'production-build-entry-drift')
    require(migration_manifest() == state['migrations'] and digest((ROOT / 'pnpm-lock.yaml').read_bytes()) == state['lockfileSha256'], 'runtime-dependency-migration-drift')
    owned_model(state, running=True)
    if side == 'target':
        for name in SERVICES:
            if name in state['resources']['source']:
                owned_container(state, 'source', name, running=False)
    for saved in state['processes'].values():
        require(saved['side'] == side, 'no-source-target-app-overlap')
    previous = state['processes'].get(service)
    require(not previous or not process_alive(previous), 'application-already-running')
    entry = Path(state['builds'][service]['entry'])
    if service in APP_PORTS:
        free_port(APP_PORTS[service])
    for filename in ['.env', '.env.local', '.env.production', '.env.production.local']:
        require(not (entry.parent / filename).exists(), 'dotenv-in-application-working-directory')
    environment = {**base_environment(), **state['environment'], 'VECTORIX_RESTORE_RUN': state['runId'], 'VECTORIX_RESTORE_SIDE': side}
    arguments = [shutil.which('node')]
    if service in APP_PORTS:
        environment.update(PORT=str(APP_PORTS[service]), HOSTNAME='127.0.0.1')
    if service == 'api':
        preload = path.parent / 'loopback.mjs'
        source = "import net from 'node:net';const f=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(a[0]&&typeof a[0]==='object'&&Number(a[0].port)===3101)a[0]={...a[0],host:'127.0.0.1'};else if(Number(a[0])===3101){if(typeof a[1]==='string')a[1]='127.0.0.1';else a.splice(1,0,'127.0.0.1');}return f.apply(this,a);};\n"
        require(not preload.is_symlink(), 'loopback-preload-path')
        preload.write_text(source)
        preload.chmod(0o600)
        arguments += ['--import', str(preload)]
    current = process_identity(os.getpid())
    state['processes'][service] = {'pid': os.getpid(), 'startTicks': current['startTicks'],
        'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'entry': str(entry), 'side': side, 'runId': state['runId']}
    if side == 'target':
        state['phase'] = 'target-acceptance-running'
    save(path, state)
    os.chdir(entry.parent)
    os.execvpe(arguments[0], arguments + [str(entry)], environment)


def capture(path, state):
    require(state['phase'] in ['source-available-for-approved-dashboard-setup', 'capture-in-progress'], 'capture-source-phase')
    bundle = path.parent / 'bundle'
    # A failed pre-export proof can resume while writers remain stopped. Partial bundles are quarantined.
    require(not bundle.exists(), 'new-private-bundle-required')
    stop_apps(state)
    save(path, state)
    no_apps(state)
    accepted = fixture(state, read_json(path.parent / 'fixture.json'))
    state['phase'] = 'capture-in-progress'
    save(path, state)
    first = snapshot(state, 'source', accepted)
    second = snapshot(state, 'source', accepted)
    require(first == second, 'unstable-pre-export-database-manifests')
    bundle.mkdir(mode=0o700)
    save_json(bundle / 'runtime.json', {'environment': state['environment'], 'infrastructureSecrets': state['infrastructureSecrets']}, exclusive=True)
    dumps, role_dumps = {}, {}
    for service in ['postgres', 'vector']:
        dumps[service] = bounded_stream(database_command(state, 'source', service, 'pg_dump', '-Fc', '--create', '--lock-wait-timeout=2000'),
                                         destination=bundle / (service + '.dump'))
        container = owned_container(state, 'source', service, running=True)
        database = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
        role_file = bundle / (service + '.roles.sql')
        role_dumps[service] = bounded_stream(['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20000',
            container['Id'], 'pg_dumpall', '-U', 'postgres', '-l', database, '--roles-only', '--quote-all-identifiers'],
            destination=role_file, maximum=MAX_ROLES, timeout=60)
        reviewed_role_import(read_private_bytes(role_file, MAX_ROLES), [row['rolname'] for row in second['databases'][service]['roles']])
    objects = object_step(state, path, 'export')
    require(snapshot(state, 'source', accepted) == second, 'database-changed-during-export')
    require(object_step(state, path, 'verify-source') == objects, 'objects-changed-during-export')
    manifest = {'version': 1, 'runId': state['runId'], 'prefix': state['prefix'], 'builds': state['builds'],
                'images': state['images'], 'ports': state['ports'], 'baseline': second, 'dumps': dumps, 'roles': role_dumps,
                'migrations': state['migrations'], 'lockfileSha256': state['lockfileSha256'], 'commit': state['commit'],
                'objects': objects, 'runtimeSha256': digest(read_private_bytes(bundle / 'runtime.json')),
                'fixtureSha256': digest(read_private_bytes(path.parent / 'fixture.json')),
                'quiescedAt': time.time(), 'claim': 'quiesced full-store fixture only; no online snapshot guarantee'}
    save_json(bundle / 'manifest.json', manifest, exclusive=True)
    state.update(phase='source-exported-still-quiescent', bundleSha256=digest(read_private_bytes(bundle / 'manifest.json')))
    save(path, state)
    return {'phase': state['phase'], **public_snapshot(second), 'objects': objects,
            'dumps': dumps, 'privateBundle': str(bundle)}


def verify_bundle(path, state):
    bundle = path.parent / 'bundle'
    private_directory(bundle)
    manifest = read_json(bundle / 'manifest.json')
    require(manifest['runId'] == state['runId'] and manifest['prefix'] == state['prefix'], 'bundle-run-prefix')
    require(digest(read_private_bytes(bundle / 'manifest.json')) == state['bundleSha256'], 'bundle-manifest-hash')
    require(manifest['ports'] == state['ports'] and manifest['images'] == state['images'] and manifest['builds'] == state['builds'], 'bundle-physical-logical-bindings')
    require(manifest['migrations'] == state['migrations'] and manifest['lockfileSha256'] == state['lockfileSha256'], 'bundle-approved-runtime-schema')
    require(digest(read_private_bytes(bundle / 'runtime.json')) == manifest['runtimeSha256'], 'protected-runtime-hash')
    protected = read_json(bundle / 'runtime.json')
    require(protected == {key: state[key] for key in ['environment', 'infrastructureSecrets']}, 'protected-runtime-exact')
    require(digest(read_private_bytes(path.parent / 'fixture.json')) == manifest['fixtureSha256'], 'accepted-fixture-hash')
    for service in ['postgres', 'vector']:
        dump = private_file(bundle / (service + '.dump'))
        require(dump.stat().st_size == manifest['dumps'][service]['bytes'] <= MAX_DUMP, 'dump-length')
        require(digest(read_private_bytes(dump, MAX_DUMP)) == manifest['dumps'][service]['sha256'], 'dump-checksum')
        roles = private_file(bundle / (service + '.roles.sql'))
        require(roles.stat().st_size == manifest['roles'][service]['bytes'] <= MAX_ROLES, 'role-dump-length')
        require(digest(read_private_bytes(roles, MAX_ROLES)) == manifest['roles'][service]['sha256'], 'role-dump-checksum')
        reviewed_role_import(read_private_bytes(roles, MAX_ROLES), [row['rolname'] for row in manifest['baseline']['databases'][service]['roles']])
    return manifest


def quarantine_capture(path, state):
    """Preserve a failed, bounded private export so the same stopped source can be captured again."""
    require(state['phase'] == 'capture-in-progress' and not state.get('bundleSha256'), 'quarantine-incomplete-capture-only')
    no_apps(state)
    require(not state['resources']['target'], 'quarantine-no-target')
    for service in SERVICES:
        owned_container(state, 'source', service, running=True)
    bundle = private_directory(path.parent / 'bundle')
    require(not (bundle / 'manifest.json').exists(), 'quarantine-refuses-complete-bundle')
    previous = state.get('quarantinedCaptures', [])
    require(isinstance(previous, list) and len(previous) < 8, 'quarantine-history-bound')
    bounds = {'runtime.json': 8 * 1024 * 1024, 'postgres.dump': MAX_DUMP, 'vector.dump': MAX_DUMP,
              'postgres.roles.sql': MAX_ROLES, 'vector.roles.sql': MAX_ROLES}
    rows = []
    for entry in bundle.iterdir():
        if entry.name == 'objects':
            private_directory(entry)
            objects = list(entry.iterdir())
            require(len(objects) <= 129, 'quarantine-object-count-bound')
            for item in objects:
                require(item.name == 'manifest.json' or re.fullmatch(r'object-[0-9]{4}\.bin', item.name), 'quarantine-object-file-name')
                maximum = 4 * 1024 * 1024 if item.name == 'manifest.json' else 2 * 1024 * 1024
                content = read_private_bytes(item, maximum)
                rows.append({'file': 'objects/' + item.name, 'bytes': len(content), 'sha256': digest(content)})
        else:
            require(entry.name in bounds, 'quarantine-unexpected-bundle-entry')
            content = read_private_bytes(entry, bounds[entry.name])
            rows.append({'file': entry.name, 'bytes': len(content), 'sha256': digest(content)})
    require(sum(row['bytes'] for row in rows) <= 210 * 1024 * 1024, 'quarantine-total-byte-bound')
    destination = path.parent / ('quarantined-bundle-' + str(time.time_ns()))
    require(not destination.exists(), 'quarantine-fresh-destination')
    os.rename(bundle, destination)
    state['quarantinedCaptures'] = [*previous, {'directory': destination.name,
        'files': len(rows), 'bytes': sum(row['bytes'] for row in rows), 'manifestSha256': digest(canonical(sorted(rows, key=lambda row: row['file'])))}]
    save(path, state)
    return {'phase': state['phase'], 'quarantinedFiles': len(rows), 'privateArtifactsPreserved': True,
            'successfulBackup': False, 'sourceModified': False}


def stop_source(path, state):
    require(state['phase'] == 'source-exported-still-quiescent', 'stop-source-after-export-only')
    verify_bundle(path, state)
    no_apps(state)
    for service in SERVICES:
        value = owned_container(state, 'source', service)
        if value['State']['Running']:
            run(['docker', 'stop', '-t', '55', value['Id']], timeout=60)
        owned_container(state, 'source', service, running=False)
    for service in SERVICES:
        free_port(state['ports'][service])
    state['phase'] = 'source-stopped-ports-released'
    save(path, state)
    return {'phase': state['phase'], 'logicalBindingsUnchanged': True}


def create_target(path, state):
    free_space()
    require(state['phase'] in ['source-stopped-ports-released', 'cleaned-target'], 'fresh-target-phase')
    require(set(state['resources']['source']) == set(SERVICES), 'recreate-target-preserves-complete-source')
    verify_bundle(path, state)
    no_apps(state)
    require(not state['resources']['target'], 'target-must-have-no-previous-resources')
    state['phase'] = 'preparing-target'
    save(path, state)
    for service in SERVICES:
        owned_container(state, 'source', service, running=False)
        free_port(state['ports'][service])
        create_service(path, state, 'target', service)
        require(state['resources']['source'][service]['volumeIdentity'] != state['resources']['target'][service]['volumeIdentity'], 'different-target-volume-identity')
    state['phase'] = 'empty-target-infrastructure'
    save(path, state)
    return {'phase': state['phase'], 'sameLogicalPorts': True, 'freshRedisVolume': True}


def restore(path, state):
    require(state['phase'] == 'empty-target-infrastructure', 'restore-empty-target-phase')
    manifest = verify_bundle(path, state)
    no_apps(state)
    state['phase'] = 'restore-in-progress'
    save(path, state)
    from m7c_restore_common import sql_json
    for service in ['postgres', 'vector']:
        value = owned_container(state, 'target', service, running=True)
        baseline_roles = manifest['baseline']['databases'][service]['roles']
        without_passwords = [{key: content for key, content in row.items() if key != 'passwordSha256'} for row in baseline_roles]
        require(role_manifest(state, 'target', service, bootstrap=True, passwords=False) == without_passwords, 'bootstrap-role-policy')
        roles_sql = reviewed_role_import(read_private_bytes(path.parent / 'bundle' / (service + '.roles.sql'), MAX_ROLES), [row['rolname'] for row in baseline_roles])
        run(['docker', 'exec', '-i', value['Id'], 'psql', '-X', '-q', '-U', 'postgres', '-d', state['bootstrapDatabase'], '-v', 'ON_ERROR_STOP=1'], input_bytes=roles_sql, timeout=30)
        require(role_manifest(state, 'target', service, bootstrap=True) == baseline_roles, 'restored-exact-role-policy-password-hashes')
        database = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
        # CREATE comes from the checked source archive, preserving original database owner/ACL/properties.
        require(database.endswith('_test') and all(char.isalnum() or char == '_' for char in database), 'created-test-database-name')
        databases = sql_json(state, 'target', service, "SELECT coalesce(json_agg(datname ORDER BY datname),'[]'::json) FROM pg_database WHERE NOT datistemplate", bootstrap=True)
        require(databases == sorted(['postgres', state['bootstrapDatabase']]), 'target-has-only-fresh-bootstrap-databases')
        with open_private(path.parent / 'bundle' / (service + '.dump'), MAX_DUMP) as stream:
            # --create cannot share --single-transaction. A failure leaves a quarantined partial target;
            # only exact-owned target cleanup/recreation may restart, never --clean on an existing DB.
            result = subprocess.run(['docker', 'exec', '-i', value['Id'], 'pg_restore', '-U', 'postgres', '-d', state['bootstrapDatabase'],
                                     '--create', '--exit-on-error'], cwd=ROOT, env=base_environment(),
                                    stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        require(result.returncode == 0, 'full-database-restore-failed-no-error-ignored')
    require(object_step(state, path, 'restore') == manifest['objects'], 'restored-object-manifest')
    state['phase'] = 'restored-not-yet-verified'
    save(path, state)
    return {'phase': state['phase'], 'schemaMigrated': False, 'redisDumpImported': False}


def verify_target(path, state):
    require(state['phase'] in ['restored-not-yet-verified', 'restored-verified-before-replay'], 'target-verification-phase')
    no_apps(state)
    manifest = verify_bundle(path, state)
    accepted = fixture(state, read_json(path.parent / 'fixture.json'))
    restored = snapshot(state, 'target', accepted)
    require(restored == manifest['baseline'], 'restored-row-role-extension-identity-manifest')
    require(object_step(state, path, 'verify-target') == manifest['objects'], 'restored-object-integrity')
    redis = owned_container(state, 'target', 'redis', running=True)
    require(run(['docker', 'exec', redis['Id'], 'redis-cli', 'DBSIZE']).strip() == b'0', 'redis-must-still-be-empty')
    proof = {'runId': state['runId'], 'stage': 'pre-replay-restored', **public_snapshot(restored),
             'objectManifest': manifest['objects'], 'redisEmpty': True, 'schemaMigrated': False,
             'dashboardVerified': False, 'normalRebuildVerified': False, 'cleanupSoakVerified': False}
    save_json(path.parent / 'pre-replay-proof.json', proof)
    state['phase'] = 'restored-verified-before-replay'
    save(path, state)
    return proof


def require_no_unknown_container(state, side, service):
    name = state['prefix'] + ('-ollama' if service == 'ollama' else '-' + side + '-' + service)
    found = run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']).strip()
    require(not found, 'unrecorded-same-name-container-requires-operator-review')


def cleanup(path, state, side):
    stop_apps(state)
    save(path, state)
    no_apps(state)
    for service in reversed(list(SERVICES)):
        saved = state['resources'][side].get(service)
        if not saved:
            continue
        if saved['id']:
            value = owned_container(state, side, service)
            if value['State']['Running']:
                run(['docker', 'stop', '-t', '55', value['Id']], timeout=60)
            owned_container(state, side, service, running=False)
            run(['docker', 'rm', value['Id']])
            saved['id'] = None
            save(path, state)  # A failed volume removal can be resumed without adopting a same-name container.
        require_no_unknown_container(state, side, service)
        owned_volume(state, side, service)
        run(['docker', 'volume', 'rm', saved['volume']])
        del state['resources'][side][service]
        save(path, state)
    # Model container and preexisting cache volume are deliberately outside this command.
    state['phase'] = 'cleaned-' + side
    save(path, state)
    return {'phase': state['phase'], 'preservedModelVolume': state['modelVolume']['name'],
            'privateBundlePreserved': (path.parent / 'bundle').exists()}


def cleanup_model(path, state):
    no_apps(state)
    require(not any(state['resources'].values()), 'model-cleanup-after-store-cleanup-only')
    if state.get('modelContainer') is None:
        require_no_unknown_container(state, 'shared', 'ollama')
        state['phase'] = 'owned-resources-cleaned-private-bundle-retained'
        save(path, state)
        return {'phase': state['phase'], 'preservedModelVolume': state['modelVolume']['name'],
                'privateBundlePreserved': (path.parent / 'bundle').exists()}
    model = owned_model(state)
    if model['State']['Running']:
        run(['docker', 'stop', '-t', '55', model['Id']], timeout=60)
    owned_model(state, running=False)
    run(['docker', 'rm', model['Id']])  # No -v and no volume-rm: the explicitly supplied model cache survives.
    state['modelContainer'] = None
    state['phase'] = 'owned-resources-cleaned-private-bundle-retained'
    save(path, state)
    return {'phase': state['phase'], 'preservedModelVolume': state['modelVolume']['name'], 'privateBundlePreserved': (path.parent / 'bundle').exists()}


def main():
    require(not STATIC_DRAFT_ONLY, 'static-draft-not-complete-or-execution-approved')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--mode', required=True, choices=['prepare-source', 'deploy-approved-source-schema', 'source-ready', 'seed', 'app', 'pause-workers',
        'stop-apps', 'capture', 'quarantine-incomplete-capture', 'stop-source', 'create-target', 'restore', 'verify-target', 'status', 'cleanup', 'cleanup-model'])
    parser.add_argument('--side', choices=['source', 'target'])
    parser.add_argument('--service', choices=['api', 'web', 'admin', 'workers'])
    parser.add_argument('--model-volume', help='Explicit existing plain local Docker model volume; never removed.')
    for service, reference in IMAGES.items():
        parser.add_argument('--' + service + '-image', default=reference, help='Already-local image reference/ID; no pull is performed.')
    arguments = parser.parse_args()
    path = state_path(arguments.run)
    # The shared nofollow lock also covers seed; an exec'd foreground app releases its CLOEXEC FD.
    with state_lock():
        if arguments.mode == 'prepare-source':
            references = {service: getattr(arguments, service + '_image') for service in IMAGES}
            require(all(isinstance(value, str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,255}', value) for value in references.values()), 'local-image-reference-format')
            output = prepare(path, arguments.run, arguments.model_volume, references)
        else:
            private_directory(path.parent)
            state = validate_state(read_json(path), arguments.run)
            if arguments.mode == 'deploy-approved-source-schema':
                output = deploy_approved_source_schema(path, state)
            elif arguments.mode == 'source-ready':
                output = source_ready(path, state)
            elif arguments.mode == 'seed':
                output = seed(path, state)
            elif arguments.mode == 'app':
                require(arguments.side and arguments.service, 'app-side-service-required')
                app(path, state, arguments.side, arguments.service)
                return
            elif arguments.mode in ['stop-apps', 'pause-workers']:
                stop_apps(state, only='workers' if arguments.mode == 'pause-workers' else None)
                save(path, state)
                output = {'phase': state['phase'], 'ownedAppsStoppedGracefully': True}
            elif arguments.mode == 'capture':
                output = capture(path, state)
            elif arguments.mode == 'quarantine-incomplete-capture':
                output = quarantine_capture(path, state)
            elif arguments.mode == 'stop-source':
                output = stop_source(path, state)
            elif arguments.mode == 'create-target':
                output = create_target(path, state)
            elif arguments.mode == 'restore':
                output = restore(path, state)
            elif arguments.mode == 'verify-target':
                output = verify_target(path, state)
            elif arguments.mode == 'cleanup':
                require(arguments.side, 'cleanup-exact-side-required')
                output = cleanup(path, state, arguments.side)
            elif arguments.mode == 'cleanup-model':
                output = cleanup_model(path, state)
            else:
                output = {'runId': state['runId'], 'phase': state['phase'], 'ports': state['ports'],
                          'resourceCounts': {side: len(rows) for side, rows in state['resources'].items()}}
    print(json.dumps(output, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        label = error.args[0] if isinstance(error, GuardError) else 'sanitized-helper-failure'
        print(json.dumps({'completed': False, 'diagnostic': label,
                          'message': 'Owned restore helper stopped. Raw configuration, content and command errors are not emitted.'}), file=sys.stderr)
        raise SystemExit(1) from None
