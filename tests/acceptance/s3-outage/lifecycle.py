"""Disabled isolated S3 recovery acceptance lifecycle; no resource operations on import."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'tests/acceptance/restore'))
from m7c_restore_common import (GuardError, base_environment, bounded_stream, canonical, digest,
    private_directory, read_private_bytes, require, run, save_json)

STATIC_DRAFT_ONLY = True
PROTOCOL_VERSION = 2
SCENARIOS = {
    'INGESTION_V1': {'namespace': 'vectorix-m7c-s3-outage', 'label': 'vectorix.m7c-s3-outage',
        'databaseStem': 'vectorix_m7c_s3_outage', 'objectPrefix': 'm7c-s3-outage'},
    'VECTOR_PROVISION_V1': {'namespace': 'vectorix-m7c-vector-provision', 'label': 'vectorix.m7c-vector-provision',
        'databaseStem': 'vectorix_m7c_vector_provision', 'objectPrefix': 'm7c-vector-provision'},
    'CLEANUP_V1': {'namespace': 'vectorix-m7c-s3-cleanup', 'label': 'vectorix.m7c-s3-cleanup',
        'databaseStem': 'vectorix_m7c_s3_cleanup', 'objectPrefix': 'm7c-s3-cleanup'},
}


def scenario_spec(scenario):
    require(type(scenario) is str and scenario in SCENARIOS, 'm7c-s3-outage-scenario-required')
    return SCENARIOS[scenario]


def app_roles(state):
    scenario_spec(state['scenario'])
    return (*APPS, 'embedding') if state['scenario'] == 'VECTOR_PROVISION_V1' else APPS


def fault_store(state):
    scenario_spec(state['scenario'])
    return 'vector' if state['scenario'] == 'VECTOR_PROVISION_V1' else 'rustfs'


def receipt_scope(state):
    scenario_spec(state['scenario'])
    return {'schemaVersion': 1, 'protocolVersion': PROTOCOL_VERSION,
        'scenario': state['scenario'], 'runId': state['runId']}


def receipt_matches(state, value):
    return isinstance(value, dict) and all(value.get(key) == item for key, item in receipt_scope(state).items())
CACHE = ROOT / 'node_modules/.cache/vectorix'
SERVICES = {'postgres': (5432, '/var/lib/postgresql'), 'vector': (5432, '/var/lib/postgresql'),
    'redis': (6379, '/data'), 'rustfs': (9000, '/data')}
IMAGES = {
    'postgres': 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873',
    'vector': 'sha256:8a4ba870cae792a4795f2ed258b0b9c1642b767db553e129c50b867e0e5f23a4',
    'redis': 'sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0',
    'rustfs': 'sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b'}
LIMITS = {'postgres': ('2', 2147483648), 'vector': ('2', 2147483648),
    'redis': ('1', 268435456), 'rustfs': ('1', 1073741824)}
BUILT_APPS = ('api', 'workers', 'web', 'admin')
APPS = ('api', 'web', 'smtp', 'workers')
DOTENV = {'.env', '.env.local', '.env.production', '.env.production.local', '.env.development'}
PRODUCTION = ['apps/api', 'apps/workers', 'apps/web', 'apps/admin', 'packages', 'pnpm-lock.yaml', 'package.json']
HELPERS = ['lifecycle.py', 'fault.py', 'private.mjs', 'seed.mjs', 'bucket.mjs', 'smtp.mjs', 'observe.mjs', 'objects.mjs', 'cleanup-fixture.mjs', 'cleanup-observe.mjs', 'vector-embedding.mjs', 'vector-curl.mjs', 'vector-workflow.mjs', 'vector-observe.mjs', 'vector-observation.mjs', 'vector-snapshot.mjs']
PHASES = {'PREPARING', 'SCHEMA_REQUIRED', 'SCHEMA_READY', 'SEEDING', 'READY', 'CLEANING', 'CLEANED_EVIDENCE_RETAINED'}



def state_path(run_id, scenario):
    require(re.fullmatch('[a-f0-9]{12}', run_id) is not None, 'm7c-s3-outage-run-format')
    return CACHE / (scenario_spec(scenario)['namespace'] + '-' + run_id) / 'state.json'


def inspect(identifier, kind='container'):
    value = json.loads(run(['docker', kind, 'inspect', identifier], timeout=10))
    require(isinstance(value, list) and len(value) == 1, 'm7c-s3-outage-one-resource')
    return value[0]


def labels(state, service):
    label = scenario_spec(state['scenario'])['label']
    return {label + '.run': state['runId'], label + '.service': service}


def volume_identity(value):
    return digest(canonical({key: value.get(key) for key in ['Name', 'CreatedAt', 'Driver', 'Labels']}))


def file_hash(path, maximum=2 * 1024 ** 2):
    path = Path(path)
    require(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(ROOT), 'm7c-s3-outage-source-file')
    require(path.stat().st_size <= maximum, 'm7c-s3-outage-source-byte-bound')
    return digest(path.read_bytes())


def source_manifest():
    paths = run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', *PRODUCTION]).split(b'\0')
    require(0 < len(paths) <= 20000, 'm7c-s3-outage-source-count')
    rows, total = [], 0
    for value in sorted(set(paths) - {b''}):
        relative = value.decode('utf8')
        path = ROOT / relative
        require(path.name not in DOTENV and not path.is_symlink() and path.is_file(), 'm7c-s3-outage-source-path')
        total += path.stat().st_size
        require(total <= 128 * 1024 ** 2, 'm7c-s3-outage-source-total-bound')
        rows.append([relative, file_hash(path, 16 * 1024 ** 2)])
    return digest(canonical(rows))


def artifact_tree(directory):
    """Hash existing deployment bytes, including standalone dependencies; never build/copy assets."""
    rows, total, visited, started = [], 0, 0, time.monotonic()
    for path in directory.rglob('*'):
        visited += 1
        require(visited <= 100000 and time.monotonic() - started <= 60, 'm7c-s3-outage-artifact-enumeration')
        if not path.is_file():
            continue
        require(path.resolve().is_relative_to(ROOT) and path.name not in DOTENV, 'm7c-s3-outage-artifact-path')
        total += path.stat().st_size
        require(total <= 512 * 1024 ** 2 and len(rows) < 40000, 'm7c-s3-outage-artifact-byte-bound')
        rows.append([path.relative_to(directory).as_posix(), path.stat().st_size, digest(path.read_bytes())])
    require(rows, 'm7c-s3-outage-existing-artifacts-required')
    return digest(canonical(sorted(rows)))


def build_manifest():
    result = {}
    for app in BUILT_APPS:
        directory = ROOT / ('apps/' + app + '/dist' if app in {'api', 'workers'}
            else 'apps/' + app + '/.next/standalone')
        entry = directory / ('index.mjs' if app in {'api', 'workers'} else 'apps/' + app + '/server.js')
        require(entry.is_file(), 'm7c-s3-outage-existing-build-required')
        if app in {'web', 'admin'}:
            require((entry.parent / '.next/static').is_dir(),
                'm7c-s3-outage-existing-standalone-static-required')
            if app == 'web':
                require((entry.parent / 'public').is_dir(), 'm7c-s3-outage-existing-web-public-required')
        result[app] = {'entry': str(entry), 'entrySha256': file_hash(entry, 32 * 1024 ** 2),
            'treeSha256': artifact_tree(directory)}
    return result


def package_root(anchor, name, optional=False):
    require(re.fullmatch(r'(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+', name) is not None,
        'm7c-s3-outage-runtime-package-name')
    for directory in [anchor, *anchor.parents]:
        if not directory.is_relative_to(ROOT):
            break
        candidate = directory / 'node_modules' / name
        if (candidate / 'package.json').is_file():
            resolved = candidate.resolve()
            require(resolved.is_relative_to(ROOT), 'm7c-s3-outage-runtime-inside-workspace')
            return resolved
    require(optional, 'm7c-s3-outage-runtime-package-required')
    return None


def runtime_manifest():
    """Pin ignored generated code and installed runtime closures without importing any package."""
    pending = [package_root(ROOT / 'apps/api', 'tsx'),
        package_root(ROOT / 'packages/db', '@prisma/adapter-pg'),
        package_root(ROOT / 'packages/db', '@prisma/client'),
        package_root(ROOT / 'apps/api', '@aws-sdk/client-s3')]
    packages, total_files, total_bytes, started = {}, 0, 0, time.monotonic()
    generated = ROOT / 'packages/db/src/generated/client'
    require(generated.is_dir() and not generated.is_symlink(), 'm7c-s3-outage-generated-client-required')
    trees = [('generated-client', generated)]
    while pending:
        directory = pending.pop()
        key = directory.relative_to(ROOT).as_posix()
        if key in packages:
            continue
        require(len(packages) < 96 and time.monotonic() - started <= 60, 'm7c-s3-outage-runtime-package-bound')
        manifest_path = directory / 'package.json'
        require(not manifest_path.is_symlink() and manifest_path.stat().st_size <= 128 * 1024,
            'm7c-s3-outage-runtime-package-manifest-bound')
        metadata = json.loads(manifest_path.read_bytes())
        packages[key] = {'name': metadata.get('name'), 'version': metadata.get('version')}
        trees.append((key, directory))
        for field in ['dependencies', 'optionalDependencies']:
            dependencies = metadata.get(field) or {}
            require(isinstance(dependencies, dict) and len(dependencies) <= 128,
                'm7c-s3-outage-runtime-dependency-bound')
            for name in dependencies:
                dependency = package_root(directory, name, optional=field == 'optionalDependencies')
                if dependency is not None:
                    pending.append(dependency)
    result = {}
    for key, directory in trees:
        rows, visited = [], 0
        for path in directory.rglob('*'):
            visited += 1
            require(visited <= 20000 and time.monotonic() - started <= 60,
                'm7c-s3-outage-runtime-tree-work-bound')
            require(not path.is_symlink(), 'm7c-s3-outage-runtime-tree-symlink-refused')
            if not path.is_file():
                continue
            size = path.stat().st_size
            total_files += 1
            total_bytes += size
            require(total_files <= 12000 and total_bytes <= 512 * 1024 ** 2,
                'm7c-s3-outage-runtime-tree-byte-bound')
            rows.append([path.relative_to(directory).as_posix(), size, file_hash(path, 64 * 1024 ** 2)])
        require(rows, 'm7c-s3-outage-runtime-tree-not-empty')
        result[key] = {'root': str(directory), 'sha256': digest(canonical(sorted(rows))),
            'files': len(rows), 'bytes': sum(row[1] for row in rows), **packages.get(key, {})}
    return result


def fixture_manifest():
    """Pin tiny immutable UTF-8 originals and their expected source metadata."""
    return {name: {'sha256': file_hash(HERE / 'fixtures' / name, 64 * 1024),
        'bytes': (HERE / 'fixtures' / name).stat().st_size}
        for name in ['s3-outage-v1.txt', 's3-outage-v2.txt', 'expected.json']}


def inputs():
    migrations = sorted((ROOT / 'packages/db/prisma/migrations').glob('*/migration.sql'))
    require(0 < len(migrations) <= 64, 'm7c-s3-outage-migration-count')
    return {'sourceSha256': source_manifest(), 'builds': build_manifest(), 'runtime': runtime_manifest(),
        'textFixtures': fixture_manifest(),
        'migrations': {p.parent.name: file_hash(p, 8 * 1024 ** 2) for p in migrations},
        'prismaConfigSha256': file_hash(ROOT / 'packages/db/prisma.config.ts'),
        'helpers': {**{name: file_hash(HERE / name) for name in HELPERS},
            'shared-restore-common.py': file_hash(ROOT / 'tests/acceptance/restore/m7c_restore_common.py')}}


def validate(state, run_id, scenario):
    spec = scenario_spec(scenario)
    require(state.get('schemaVersion') == 1 and state.get('protocolVersion') == PROTOCOL_VERSION
        and state.get('scenario') == scenario and state.get('namespace') == spec['namespace']
        and state.get('runId') == run_id and state.get('prefix') == spec['namespace'] + '-' + run_id
        and state.get('phase') in PHASES, 'm7c-s3-outage-state-identity')
    require(state['applicationDatabase'] == spec['databaseStem'] + '_app_' + run_id + '_test'
        and state['vectorDatabase'] == spec['databaseStem'] + '_vectors_' + run_id + '_test', 'm7c-s3-outage-test-databases')
    require(state['images'] == IMAGES and set(state['resources']).issubset(SERVICES)
        and set(state['processes']).issubset(app_roles(state)), 'm7c-s3-outage-state-resource-set')
    port_names = {*SERVICES, 'api', 'web', 'admin', 'smtp'} | ({'embedding'} if state['scenario'] == 'VECTOR_PROVISION_V1' else set())
    require(set(state['ports']) == port_names
        and all(type(p) is int and 1024 < p < 65536 for p in state['ports'].values())
        and len(set(state['ports'].values())) == len(port_names), 'm7c-s3-outage-port-bindings')
    require(state['environment'] == environment(state), 'm7c-s3-outage-exact-isolated-environment')
    for app, saved in state['processes'].items():
        require(saved['service'] == app and saved['entry'] == str(app_entry(state, app))
            and type(saved['pid']) is int and saved['pid'] > 1, 'm7c-s3-outage-saved-process-binding')
    return state


def load(run_id, scenario):
    path = state_path(run_id, scenario)
    private_directory(path.parent)
    return validate(json.loads(read_private_bytes(path, 128 * 1024)), run_id, scenario)


def app_entry(state, service):
    return HERE / ('smtp.mjs' if service == 'smtp' else 'vector-embedding.mjs') if service in {'smtp', 'embedding'} else Path(state['inputs']['builds'][service]['entry'])


def app_entry_hash(state, service):
    return state['inputs']['helpers']['smtp.mjs' if service == 'smtp' else 'vector-embedding.mjs'] if service in {'smtp', 'embedding'} else state['inputs']['builds'][service]['entrySha256']


def app_environment(state, service):
    if service == 'embedding':
        require(state['scenario'] == 'VECTOR_PROVISION_V1', 'm7c-vector-fixture-scenario')
        return {'NODE_ENV': 'production', 'TZ': 'UTC', 'VECTORIX_M7C_S3_OUTAGE_RUN': state['runId'],
            'VECTORIX_M7C_S3_OUTAGE_ROLE': service, 'VECTORIX_M7C_S3_SCENARIO': state['scenario']}
    return {**state['environment'], 'VECTORIX_M7C_S3_OUTAGE_RUN': state['runId'],
        'VECTORIX_M7C_S3_OUTAGE_ROLE': service, 'VECTORIX_M7C_S3_SCENARIO': state['scenario']}


def smtp_ready(state):
    value = json.loads(read_private_bytes(state_path(state['runId'], state['scenario']).parent / 'smtp-ready.json', 4096))
    require(value == {**receipt_scope(state), 'smtpPort': state['ports']['smtp'],
        'scope': 'OWNED_LOOPBACK_CAPTURE_ONLY'}, 'm7c-s3-outage-smtp-ready-receipt')


def save(state, exclusive=False):
    validate(state, state['runId'], state['scenario'])
    save_json(state_path(state['runId'], state['scenario']), state, exclusive=exclusive)


@contextmanager
def lifecycle_lock(scenario):
    descriptor = os.open(CACHE / (scenario_spec(scenario)['namespace'] + '-lifecycle.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600,
            'm7c-s3-outage-private-lock')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def free_port(port=0):
    with socket.socket() as handle:
        handle.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            handle.bind(('127.0.0.1', port))
        except OSError:
            raise GuardError('m7c-s3-outage-loopback-port-unavailable') from None
        return handle.getsockname()[1]


def environment(state):
    ports, secret = state['ports'], state['secrets']
    spec = scenario_spec(state['scenario'])
    origin = lambda app: 'http://127.0.0.1:' + str(ports[app])
    trust = origin('web') + ',' + origin('admin')
    empty = ['ROOT_DOMAIN', 'BETTER_AUTH_COOKIE_NAME', 'BETTER_AUTH_COOKIE_PREFIX', 'VECTORIX_FEATURE_PROVIDER_URL',
        'VECTORIX_DEFAULT_RESEND_API_KEY', 'VECTORIX_DEFAULT_SMTP_USER', 'VECTORIX_DEFAULT_SMTP_PASSWORD',
        'VECTORIX_DEFAULT_COHERE_API_KEY',
        'VECTORIX_DEFAULT_VOYAGE_API_KEY', 'VECTORIX_DEFAULT_OPENAI_API_KEY', 'VECTORIX_DEFAULT_MISTRAL_API_KEY',
        'VECTORIX_DEFAULT_OLLAMA_API_KEY', 'VECTORIX_DEFAULT_OLLAMA_ENDPOINT', 'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS']
    env = dict.fromkeys(empty, '')
    env.update(NODE_ENV='production', TZ='UTC', VECTORIX_TIME_ZONE='Europe/Brussels',
        DATABASE_URL='postgresql://postgres:' + quote(secret['postgres'], safe='') + '@127.0.0.1:' + str(ports['postgres']) + '/' + state['applicationDatabase'],
        VECTOR_DATABASE_URL='postgresql://vectorix_runtime:' + quote(secret['runtime'], safe='') + '@127.0.0.1:' + str(ports['vector']) + '/' + state['vectorDatabase'],
        VECTOR_DATABASE_PROVISIONING_URL='postgresql://vectorix_indexer:' + quote(secret['indexer'], safe='') + '@127.0.0.1:' + str(ports['vector']) + '/' + state['vectorDatabase'],
        VECTOR_DATABASE_SCHEMA='vector_collections', REDIS_URL='redis://127.0.0.1:' + str(ports['redis']),
        BETTER_AUTH_SECRET=secret['auth'], ENCRYPTION_SECRET=secret['encryption'],
        VECTORIX_DEFAULT_SMTP_HOST='127.0.0.1', VECTORIX_DEFAULT_SMTP_PORT=str(ports['smtp']),
        VECTORIX_DEFAULT_SMTP_SENDER_EMAIL='ownership@example.test', VECTORIX_DEFAULT_RESEND_SENDER_EMAIL='',
        BETTER_AUTH_URL=origin('api'), API_URL=origin('api'), VECTORIX_WEB_URL=origin('web'), TRUSTED_ORIGINS=trust,
        ALLOW_ACCOUNT_CREATION='true', ALLOW_ORGANIZATION_CREATION='true', VECTORIX_WEB_PUSH_ENABLED='false',
        VECTORIX_DEFAULT_S3_ENDPOINT=origin('rustfs'), VECTORIX_S3_ALLOWED_ENDPOINTS=origin('rustfs'),
        VECTORIX_DEFAULT_S3_BUCKET=spec['objectPrefix'] + '-' + state['runId'], VECTORIX_DEFAULT_S3_REGION='us-east-1',
        VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE='true', VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=spec['objectPrefix'] + '-' + state['runId'],
        VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=secret['s3'],
        PASSKEY_RP_ID='127.0.0.1', PASSKEY_RP_NAME='Vectorix isolated S3 recovery', PASSKEY_ORIGINS=trust)
    if state['scenario'] == 'VECTOR_PROVISION_V1':
        env.update(VECTORIX_DEFAULT_OLLAMA_ENDPOINT=origin('embedding'), VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS=origin('embedding'))
    return env


def owned_volume(state, service):
    saved = state['resources'][service]
    value = inspect(saved['volume'], 'volume')
    require(value['Name'] == state['prefix'] + '-' + service + '-data'
        and value['Driver'] == 'local' and value.get('Options') in [None, {}]
        and value.get('Labels') == labels(state, service)
        and volume_identity(value) == saved['volumeIdentity'], 'm7c-s3-outage-owned-volume-identity')
    return value


def owned(state, service, running=None):
    saved = state['resources'][service]
    require(saved['id'] is not None, 'm7c-s3-outage-unrecorded-container')
    value = inspect(saved['id'])
    port, mount = SERVICES[service]
    require(value['Id'] == saved['id'] and value['Name'] == '/' + saved['name']
        and saved['name'] == state['prefix'] + '-' + service and value['Image'] == IMAGES[service]
        and value['Created'] == saved['createdAt'], 'm7c-s3-outage-container-identity')
    require(all((value['Config'].get('Labels') or {}).get(k) == v for k, v in labels(state, service).items())
        and not value['HostConfig']['Privileged'] and value['HostConfig']['NetworkMode'] == 'bridge'
        and not value['HostConfig'].get('VolumesFrom') and not value['HostConfig'].get('Links')
        and value['HostConfig']['NanoCpus'] == int(LIMITS[service][0]) * 1000000000
        and value['HostConfig']['Memory'] == LIMITS[service][1], 'm7c-s3-outage-container-isolation')
    require(value['HostConfig']['PortBindings'] == {str(port) + '/tcp':
        [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports'][service])}]}, 'm7c-s3-outage-container-port')
    mounts = value['Mounts']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['Name'] == saved['volume']
        and mounts[0]['Destination'] == mount and mounts[0]['RW'] is True, 'm7c-s3-outage-container-mount')
    owned_volume(state, service)
    if running is not None:
        require(value['State']['Running'] is running, 'm7c-s3-outage-container-running-state')
    return value


def curl_manifest():
    file = Path('/usr/bin/curl')
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022 and file.resolve() == file and info.st_size <= 16 * 1024 ** 2, 'm7c-vector-curl-binary')
    return {'path': str(file), 'sha256': digest(file.read_bytes())}


def pins(state):
    expected = {**inputs(), **({'curl': curl_manifest()} if state['scenario'] == 'VECTOR_PROVISION_V1' else {})}
    require(expected == state['inputs'], 'm7c-s3-outage-source-build-helper-migration-drift')


def create_service(state, service):
    spec = scenario_spec(state['scenario'])
    name = state['prefix'] + '-' + service
    require(not run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']).strip(),
        'm7c-s3-outage-refuse-existing-container')
    volume = name + '-data'
    require(not run(['docker', 'volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}']).strip(),
        'm7c-s3-outage-refuse-existing-volume')
    args = [arg for key, value in labels(state, service).items() for arg in ['--label', key + '=' + value]]
    run(['docker', 'volume', 'create', *args, volume])
    value = inspect(volume, 'volume')
    state['resources'][service] = {'id': None, 'name': name, 'createdAt': None, 'volume': volume,
        'volumeIdentity': volume_identity(value)}
    save(state)
    owned_volume(state, service)
    values = {}
    if service in {'postgres', 'vector'}:
        values = {'POSTGRES_PASSWORD': state['secrets']['postgres'],
            'POSTGRES_DB': state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']}
        if service == 'vector':
            values.update(VECTOR_PROVISIONER_PASSWORD=state['secrets']['indexer'], VECTOR_RUNTIME_PASSWORD=state['secrets']['runtime'])
    elif service == 'rustfs':
        values = {'RUSTFS_ACCESS_KEY': spec['objectPrefix'] + '-' + state['runId'], 'RUSTFS_SECRET_KEY': state['secrets']['s3'],
            'RUSTFS_REGION': 'us-east-1', 'RUSTFS_CONSOLE_ENABLE': 'false', 'RUSTFS_OBS_LOG_DIRECTORY': '/tmp/logs'}
    free_port(state['ports'][service])
    identifier = run(['docker', 'create', '--pull=never', '--name', name, '--network=bridge', *args,
        '--cpus', LIMITS[service][0], '--memory', str(LIMITS[service][1]),
        '--mount', 'type=volume,src=' + volume + ',dst=' + SERVICES[service][1],
        '-p', '127.0.0.1:' + str(state['ports'][service]) + ':' + str(SERVICES[service][0]),
        *[arg for key in values for arg in ['-e', key]], IMAGES[service], *(['/data'] if service == 'rustfs' else [])],
        environment={**base_environment(), **values}, timeout=55).decode().strip()
    require(re.fullmatch('[a-f0-9]{64}', identifier) is not None, 'm7c-s3-outage-created-container-id')
    value = inspect(identifier)
    state['resources'][service].update(id=identifier, createdAt=value['Created'])
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
            require(result.returncode in {0, 1, 2}, 'm7c-s3-outage-postgres-probe-exit')
            if result.returncode == 0:
                return
            time.sleep(0.5)
        raise GuardError('m7c-s3-outage-postgres-tcp-readiness')


def db_query(state, sql, service='postgres'):
    require(sql.startswith('SELECT ') and len(sql) <= 8192, 'm7c-s3-outage-readonly-sql')
    value = owned(state, service, running=True)
    database = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
    return json.loads(run(['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000',
        value['Id'], 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', sql], timeout=20))


def schema(state):
    rows = db_query(state, 'SELECT coalesce(json_object_agg(migration_name,checksum),\'{}\'::json) FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
    require(rows == state['inputs']['migrations'], 'm7c-s3-outage-deployed-migration-chain')


def empty(state):
    result = db_query(state, 'SELECT json_build_array((SELECT count(*) FROM public."user"),(SELECT count(*) FROM public.organization),(SELECT count(*) FROM public.member),(SELECT count(*) FROM public."Document"),(SELECT count(*) FROM public."Collection"))')
    require(result == [0, 0, 0, 0, 0], 'm7c-s3-outage-fresh-empty-business-database-required')


def prepare(run_id, scenario):
    spec = scenario_spec(scenario)
    path = state_path(run_id, scenario)
    require(not path.parent.exists() and shutil.disk_usage(CACHE).free >= 4 * 1024 ** 3, 'm7c-s3-outage-fresh-directory-and-disk-required')
    ports = {}
    for service in [*SERVICES, 'api', 'web', 'admin', 'smtp', *(['embedding'] if scenario == 'VECTOR_PROVISION_V1' else [])]:
        ports[service] = free_port()
        require(len(set(ports.values())) == len(ports), 'm7c-s3-outage-distinct-selected-ports')
    for service, identifier in IMAGES.items():
        image = inspect(identifier, 'image')
        require(image['Id'] == identifier and set(image['Config'].get('Volumes') or {}).issubset({SERVICES[service][1]}),
            'm7c-s3-outage-existing-local-image-no-extra-volume')
    state = {'schemaVersion': 1, 'protocolVersion': PROTOCOL_VERSION, 'scenario': scenario,
        'namespace': spec['namespace'], 'runId': run_id, 'prefix': spec['namespace'] + '-' + run_id,
        'phase': 'PREPARING', 'ports': ports, 'images': IMAGES, 'resources': {}, 'processes': {},
        'inputs': {**inputs(), **({'curl': curl_manifest()} if scenario == 'VECTOR_PROVISION_V1' else {})}, 'commit': run(['git', 'rev-parse', 'HEAD']).decode().strip(),
        'applicationDatabase': spec['databaseStem'] + '_app_' + run_id + '_test',
        'vectorDatabase': spec['databaseStem'] + '_vectors_' + run_id + '_test',
        'secrets': {**{k: secrets.token_urlsafe(32) for k in ['postgres', 'indexer', 'runtime', 's3', 'auth']},
            'encryption': secrets.token_hex(32)}}
    state['environment'] = environment(state)
    path.parent.mkdir(mode=0o700)
    save(state, exclusive=True)
    for service in SERVICES:
        create_service(state, service)
    state['phase'] = 'SCHEMA_REQUIRED'
    save(state)
    return state


def deploy(state):
    require(state['phase'] == 'SCHEMA_REQUIRED' and not state['processes'], 'm7c-s3-outage-deploy-before-apps')
    pins(state)
    for service in SERVICES:
        owned(state, service, running=True)
    directory = ROOT / 'packages/db'
    require(not any((directory / filename).exists() for filename in DOTENV), 'm7c-s3-outage-prisma-dotenv-refused')
    binary = directory / 'node_modules/prisma/build/index.js'
    require(binary.resolve().is_relative_to(ROOT) and binary.is_file(), 'm7c-s3-outage-installed-prisma-required')
    run([shutil.which('node'), str(binary), 'migrate', 'deploy', '--config', str(directory / 'prisma.config.ts')],
        environment={**base_environment(), 'DATABASE_URL': state['environment']['DATABASE_URL'], 'DOTENV_CONFIG_PATH': '/dev/null'},
        directory=directory, timeout=180)
    schema(state)
    empty(state)
    child(state, 'bucket')
    state['phase'] = 'SCHEMA_READY'
    save(state)


def process_identity(pid):
    try:
        directory = Path('/proc') / str(pid)
        fields = (directory / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] in {'Z', 'X', 'x'}:
            return None
        return {'state': fields[0], 'startTicks': fields[19], 'command': (directory / 'cmdline').read_bytes().split(b'\0'),
            'cwd': str(Path(os.readlink(directory / 'cwd'))), 'environment': (directory / 'environ').read_bytes().split(b'\0'),
            'uid': directory.stat().st_uid}
    except (FileNotFoundError, ProcessLookupError):
        return None


def process_alive(state, saved):
    if saved['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        return False
    value = process_identity(saved['pid'])
    if not value or value['startTicks'] != saved['startTicks']:
        return False
    require(value['uid'] == os.getuid() and value['cwd'] == saved['cwd'], 'm7c-s3-outage-process-owner-cwd')
    exact = saved['entry'].encode() in value['command']
    next_entry = value['command'][0].startswith(b'next-server ') and saved['service'] in {'web', 'admin'}
    require(exact or next_entry, 'm7c-s3-outage-process-entry')
    for key, content in app_environment(state, saved['service']).items():
        require([v for v in value['environment'] if v.startswith(key.encode() + b'=')] == [(key + '=' + content).encode()],
            'm7c-s3-outage-process-environment')
    if saved['service'] != 'workers':
        require(('PORT=' + str(state['ports'][saved['service']])).encode() in value['environment'], 'm7c-s3-outage-process-port')
    require(file_hash(saved['entry'], 32 * 1024 ** 2) == app_entry_hash(state, saved['service']),
        'm7c-s3-outage-process-entry-drift')
    return True


def app(state, service):
    require(service in app_roles(state) and state['phase'] in ({'SCHEMA_READY', 'SEEDING', 'READY'} if service in {'api', 'smtp', 'embedding'} else {'READY'}),
        'm7c-s3-outage-application-phase')
    pins(state)
    for item in SERVICES:
        owned(state, item, running=True)
    require(service not in state['processes'], 'm7c-s3-outage-process-invocation-no-replay')
    if service in {'api', 'workers'}:
        require('smtp' in state['processes'] and process_alive(state, state['processes']['smtp']),
            'm7c-s3-outage-owned-smtp-before-api')
        smtp_ready(state)
    if state['scenario'] == 'VECTOR_PROVISION_V1' and service in {'api', 'workers'}:
        require('embedding' in state['processes'] and process_alive(state, state['processes']['embedding']), 'm7c-vector-owned-embedding-required')
        require(json.loads(read_private_bytes(state_path(state['runId'], state['scenario']).parent / 'embedding-ready.json', 4096)) == {**receipt_scope(state), 'port': state['ports']['embedding'], 'synthetic': True}, 'm7c-vector-fixture-ready')
    entry = app_entry(state, service)
    require(not any((entry.parent / filename).exists() for filename in DOTENV), 'm7c-s3-outage-runtime-dotenv-refused')
    env = {**base_environment(), **app_environment(state, service)}
    arguments = [shutil.which('node')]
    if service != 'workers':
        free_port(state['ports'][service])
        env.update(PORT=str(state['ports'][service]), HOSTNAME='127.0.0.1')
    if service == 'api':
        # The production Hono entry has no host option; bind only its exact port to loopback.
        preload = state_path(state['runId'], state['scenario']).parent / 'api-loopback.mjs'
        content = ("import net from 'node:net';const f=net.Server.prototype.listen;const p=" + str(state['ports']['api'])
            + ";net.Server.prototype.listen=function(...a){if(a[0]&&typeof a[0]==='object'&&Number(a[0].port)===p)a[0]={...a[0],host:'127.0.0.1'};else if(Number(a[0])===p){if(typeof a[1]==='string')a[1]='127.0.0.1';else a.splice(1,0,'127.0.0.1');}return f.apply(this,a);};\n").encode()
        if preload.exists():
            require(read_private_bytes(preload, 4096) == content, 'm7c-s3-outage-loopback-preload-drift')
        else:
            fd = os.open(preload, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
        arguments += ['--import', str(preload)]
    current = process_identity(os.getpid())
    require(current is not None, 'm7c-s3-outage-current-process-identity')
    state['processes'][service] = {'pid': os.getpid(), 'startTicks': current['startTicks'],
        'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'service': service,
        'entry': str(entry), 'cwd': str(entry.parent)}
    save(state)
    # Each command becomes its foreground Node process. Logs are private, never emitted by this CLI.
    log = state_path(state['runId'], state['scenario']).parent / (service + '-' + current['startTicks'] + '.log')
    fd = os.open(log, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)
    os.chdir(entry.parent)
    os.execvpe(arguments[0], arguments + [str(entry)] + (['--run', state['runId'], '--scenario', state['scenario']] if service in {'smtp', 'embedding'} else []), env)


def fault_phase(state):
    """Immutable intervention evidence always dominates successful operator receipts."""
    directory = state_path(state['runId'], state['scenario']).parent
    ordered = [('watchdog-intervention.json', 'WATCHDOG_INTERVENED'),
        ('fault-complete-receipt.json', 'COMPLETE'), ('fault-restore-receipt.json', 'RESTORED'),
        ('fault-storage-outage-receipt.json', 'OUTAGE'), ('fault-pause-receipt.json', 'PAUSED'),
        ('watchdog-ack.json', 'ARMED')]
    for filename, phase in ordered:
        if (directory / filename).exists():
            value = json.loads(read_private_bytes(directory / filename, 8192))
            require(receipt_matches(state, value),
                'm7c-s3-outage-fault-receipt-scope')
            return phase
    return 'NOT_STARTED'


def control_alive(saved):
    """Verify a control process without interpreting its environment or trusting a recycled PID."""
    if saved.get('bootId') != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        return False
    value = process_identity(saved['pid'])
    if not value or value['startTicks'] != saved['startTicks']:
        return False
    require(value['uid'] == os.getuid() and value['cwd'] == saved['cwd']
        and digest(b'\0'.join(value['command'])) == saved['commandSha256'],
        'm7c-s3-outage-control-process-identity')
    return True


def watchdog_admission(state):
    directory = state_path(state['runId'], state['scenario']).parent
    ack = json.loads(read_private_bytes(directory / 'watchdog-ack.json', 8192))
    require(receipt_matches(state, ack)
        and ack.get('budgetSeconds') == 900 and ack.get('worker') == state['processes']['workers']
        and ack.get(fault_store(state)) == state['resources'][fault_store(state)] and control_alive(ack['control'])
        and type(ack.get('deadlineMonotonicNs')) is str and ack['deadlineMonotonicNs'].isdigit()
        and time.monotonic_ns() < int(ack['deadlineMonotonicNs'])
        and not (directory / 'watchdog-intervention.json').exists(),
        'm7c-s3-outage-original-watchdog-required')
    return ack


def guard(state, purpose):
    purposes = {'bucket', 'seed', 'check', 'smtp', 'embedding', 'observe', 'staged-observe', 'outage-observe'}
    require(purpose in purposes, 'm7c-s3-outage-guard-purpose')
    pins(state)
    require(set(state['resources']) == set(SERVICES), 'm7c-s3-outage-four-owned-stores-required')
    phase = fault_phase(state)
    for service in SERVICES:
        owned(state, service, running=not (service == fault_store(state) and (purpose == 'outage-observe' or (purpose == 'embedding' and phase == 'OUTAGE'))))
    schema(state)
    if purpose in {'bucket', 'seed'}:
        require(state['phase'] in ({'SCHEMA_REQUIRED'} if purpose == 'bucket' else {'SEEDING'}), 'm7c-s3-outage-setup-phase')
        empty(state)
    if purpose in {'seed', 'check', 'observe', 'staged-observe', 'outage-observe'}:
        require('api' in state['processes'] and process_alive(state, state['processes']['api']), 'm7c-s3-outage-owned-api-required')
        require('smtp' in state['processes'] and process_alive(state, state['processes']['smtp']), 'm7c-s3-outage-owned-smtp-required')
        smtp_ready(state)
    if purpose == 'smtp':
        require(state['phase'] in {'SCHEMA_READY', 'SEEDING', 'READY'} and 'smtp' in state['processes']
            and process_alive(state, state['processes']['smtp']), 'm7c-s3-outage-smtp-start-phase')
    if purpose == 'embedding':
        require(state['scenario'] == 'VECTOR_PROVISION_V1' and state['phase'] in {'SCHEMA_READY', 'SEEDING', 'READY'} and 'embedding' in state['processes'] and process_alive(state, state['processes']['embedding']), 'm7c-vector-fixture-start-phase')
        if phase in {'PAUSED', 'OUTAGE'}:
            watchdog_admission(state)
    if purpose in {'check', 'observe', 'staged-observe', 'outage-observe'}:
        for service, saved in state['processes'].items():
            require(process_alive(state, saved), 'm7c-s3-outage-recorded-process-not-live')
            actual = process_identity(saved['pid'])
            stopped = service == 'workers' and purpose == 'staged-observe'
            require((actual['state'] == 'T') if stopped else actual['state'] not in {'T', 't'},
                'm7c-s3-outage-exact-process-run-state')
    if purpose in {'observe', 'staged-observe', 'outage-observe'}:
        require(state['phase'] == 'READY' and set(state['processes']) == set(app_roles(state)), 'm7c-s3-outage-observe-four-processes-required')
        if purpose == 'staged-observe':
            require(phase == 'PAUSED', 'm7c-s3-outage-stage-phase')
            watchdog_admission(state)
        elif purpose == 'outage-observe':
            require(phase == 'OUTAGE', 'm7c-s3-outage-outage-phase')
            watchdog_admission(state)
        else:
            require(phase in {'NOT_STARTED', 'ARMED', 'RESTORED', 'COMPLETE'}, 'm7c-s3-outage-online-phase')
            if phase in {'RESTORED', 'COMPLETE'}:
                final = json.loads(read_private_bytes(state_path(state['runId'], state['scenario']).parent / 'watchdog-final.json', 8192))
                require(receipt_matches(state, final)
                    and final.get('intervened') is False and final.get('storageRunning') is True
                    and final.get('sameWorkerResumed') is True, 'm7c-s3-outage-watchdog-normal-stop-required')
    return {**receipt_scope(state), 'namespace': state['namespace'], 'purpose': purpose,
        'resourceOwnership': True, 'exactTestDatabases': True, 'sourceBuildPins': True}


def child(state, operation):
    require(operation in {'seed', 'bucket'}, 'm7c-s3-outage-child-operation')
    result = bounded_stream([shutil.which('node'), str(HERE / (operation + '.mjs')),
        '--run', state['runId'], '--scenario', state['scenario']], environment=base_environment(), capture=True, maximum=16384, timeout=180,
        allowed_exit_codes=(0, 1))
    try:
        value = json.loads(result['data'])
    except (ValueError, UnicodeError):
        raise GuardError('m7c-s3-outage-child-safe-protocol') from None
    require(result['exitCode'] == 0 and value == {**receipt_scope(state), 'completed': True, 'operation': operation},
        'm7c-s3-outage-child-incomplete-no-replay')


def seed(state):
    require(state['phase'] == 'SCHEMA_READY', 'm7c-s3-outage-seed-once-fresh-phase')
    state['phase'] = 'SEEDING'
    save(state)
    guard(state, 'seed')
    child(state, 'seed')
    fixture = json.loads(read_private_bytes(state_path(state['runId'], state['scenario']).parent / 'fixture.json', 16384))
    require(receipt_matches(state, fixture) and set(fixture.get('users', {})) == {'owner'}
        and fixture.get('setup', {}).get('directWrites') == 'NONE_NATIVE_HTTP_ONLY',
        'm7c-s3-outage-private-fixture-required')
    state['phase'] = 'READY'
    save(state)


def cleanup(state):
    """Gracefully stop only identity-checked processes, then exact owned stores; evidence is retained."""
    state['phase'] = 'CLEANING'
    save(state)
    ack_path = state_path(state['runId'], state['scenario']).parent / 'watchdog-ack.json'
    if ack_path.exists():
        ack = json.loads(read_private_bytes(ack_path, 8192))
        require(receipt_matches(state, ack),
            'm7c-s3-outage-cleanup-watchdog-scope')
        control = ack['control']
        if control_alive(control):
            descriptor = os.pidfd_open(control['pid'])
            try:
                if control_alive(control):
                    signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            finally:
                os.close(descriptor)
            until = time.monotonic() + 65
            while control_alive(control):
                require(time.monotonic() < until, 'm7c-s3-outage-watchdog-graceful-stop-timeout')
                time.sleep(0.1)
    worker = state['processes'].get('workers')
    if worker and process_alive(state, worker) and process_identity(worker['pid'])['state'] == 'T':
        descriptor = os.pidfd_open(worker['pid'])
        try:
            if process_alive(state, worker):
                signal.pidfd_send_signal(descriptor, signal.SIGCONT)
        finally:
            os.close(descriptor)
    for saved in state['processes'].values():
        if process_alive(state, saved):
            # pidfd prevents signaling a recycled PID between the identity check and the signal.
            descriptor = os.pidfd_open(saved['pid'])
            try:
                if process_alive(state, saved):
                    signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            finally:
                os.close(descriptor)
    deadline = time.monotonic() + 55
    while any(process_alive(state, saved) for saved in state['processes'].values()):
        require(time.monotonic() < deadline, 'm7c-s3-outage-graceful-stop-timeout-no-kill')
        time.sleep(0.1)
    for service in reversed(SERVICES):
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
        require(not run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + saved['name'] + '$', '--format', '{{.ID}}']).strip(),
            'm7c-s3-outage-unrecorded-container-refuse-cleanup')
        owned_volume(state, service)
        require(not run(['docker', 'container', 'ls', '--all', '--filter', 'volume=' + saved['volume'], '--format', '{{.ID}}']).strip(),
            'm7c-s3-outage-unexpected-volume-consumer')
        run(['docker', 'volume', 'rm', saved['volume']], timeout=30)
        del state['resources'][service]
        save(state)
    state['phase'] = 'CLEANED_EVIDENCE_RETAINED'
    save(state)


def summary(state):
    # Ports/origins are public recipe values; credentials, IDs, database URLs and logs are omitted.
    return {**receipt_scope(state), 'completed': True, 'phase': state['phase'],
        'origins': {app: 'http://127.0.0.1:' + str(state['ports'][app]) for app in ['api', 'web', 'admin']},
        'smtpLoopbackPort': state['ports']['smtp'],
        'resourceCount': len(state['resources']), 'privateEvidenceRetained': True,
        'browserAcceptance': 'NOT_RUN_BY_HELPER'}


def main():
    require(not STATIC_DRAFT_ONLY, 'm7c-s3-outage-draft-awaiting-root-review')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True)
    parser.add_argument('--scenario', required=True, choices=sorted(SCENARIOS))
    parser.add_argument('--mode', required=True, choices=['prepare', 'deploy-existing-migrations', 'app-api',
        'app-web', 'app-smtp', 'app-workers', 'app-embedding', 'seed', 'check', 'cleanup', 'guard'])
    parser.add_argument('--purpose', choices=['bucket', 'seed', 'check', 'smtp', 'embedding', 'observe', 'staged-observe', 'outage-observe'])
    args = parser.parse_args()
    source = HERE.lstat()
    require(stat.S_ISDIR(source.st_mode) and source.st_uid == os.getuid()
        and stat.S_IMODE(source.st_mode) in {0o700, 0o755} and HERE.resolve() == HERE,
        'm7c-s3-outage-source-directory')
    CACHE.mkdir(mode=0o700, parents=True, exist_ok=True)
    cache = CACHE.lstat()
    require(stat.S_ISDIR(cache.st_mode) and cache.st_uid == os.getuid()
        and stat.S_IMODE(cache.st_mode) in {0o700, 0o755} and CACHE.resolve() == CACHE,
        'm7c-s3-outage-cache-directory')
    if args.mode == 'guard':
        print(json.dumps(guard(load(args.run, args.scenario), args.purpose), sort_keys=True))
        return
    with lifecycle_lock(args.scenario):
        if args.mode == 'prepare':
            state = prepare(args.run, args.scenario)
        else:
            state = load(args.run, args.scenario)
            if args.mode == 'deploy-existing-migrations':
                deploy(state)
            elif args.mode.startswith('app-'):
                app(state, args.mode[4:])
            elif args.mode == 'seed':
                seed(state)
            elif args.mode == 'check':
                guard(state, 'check')
            elif args.mode == 'cleanup':
                cleanup(state)
        print(json.dumps(summary(state), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        code = str(error) if isinstance(error, GuardError) and re.fullmatch('[a-z0-9-]{1,100}', str(error)) else 'm7c-s3-outage-sanitized-failure'
        print(json.dumps({'completed': False, 'diagnostic': code}), file=sys.stderr)
        sys.exit(1)
