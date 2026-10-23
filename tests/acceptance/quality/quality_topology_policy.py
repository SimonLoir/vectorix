"""Quality-only pure policy. Importing performs no resource or process inspection."""
from __future__ import annotations

from decimal import Decimal
import hashlib
from pathlib import Path
import re
import sys

ROOT = next((parent for parent in Path(__file__).resolve().parents
    if (parent / 'pnpm-workspace.yaml').is_file()
    and (parent / 'packages/db/prisma/schema.prisma').is_file()), None)
if ROOT is None:
    raise RuntimeError('quality-workspace-not-found')
sys.path.insert(0, str(ROOT / 'tests/acceptance/restore'))
from m7c_restore_common import (BASE_ENVIRONMENT_KEYS, CACHE, GuardError, canonical,
    digest, read_private_bytes, require, volume_identity)

NAMESPACE = 'vectorix-m7c-quality'
LABEL = 'vectorix.quality-test'
SERVICES = {'postgres': (5432, '/var/lib/postgresql'),
    'vector': (5432, '/var/lib/postgresql'), 'redis': (6379, '/data'),
    'rustfs': (9000, '/data'), 'ollama': (11434, '/root/.ollama')}
APP_SERVICES = {'api', 'workers', 'web'}
PHASES = {'PREPARING', 'APP_DB_EMPTY_SCHEMA_REQUIRED', 'SCHEMA_VERIFIED_EMPTY',
    'BOOTSTRAPPING', 'READY_FOR_QUALITY_IMPORT', 'QUALITY_CAPTURE_COMPLETE',
    'QUALITY_CAPTURE_INCOMPLETE', 'CLEANING', 'CLEANED_EVIDENCE_RETAINED'}
DEFAULT_LIMITS = {'postgres': {'cpus': '2', 'memoryBytes': 2 * 1024 ** 3},
    'vector': {'cpus': '2', 'memoryBytes': 4 * 1024 ** 3},
    'redis': {'cpus': '1', 'memoryBytes': 256 * 1024 ** 2},
    'rustfs': {'cpus': '1', 'memoryBytes': 1024 ** 3},
    'ollama': {'cpus': '4', 'memoryBytes': 6 * 1024 ** 3}}
SAFE_ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
HASH = re.compile(r'[a-f0-9]{64}')
ENVIRONMENT_KEYS = frozenset(BASE_ENVIRONMENT_KEYS)


def state_path(run_id):
    require(isinstance(run_id, str) and re.fullmatch('[a-f0-9]{12}', run_id), 'quality-run-format')
    return CACHE / (NAMESPACE + '-' + run_id) / 'state.json'


def labels(run_id, service):
    require(service in SERVICES, 'quality-known-service')
    return {LABEL + '.id': run_id, LABEL + '.service': service}


def valid_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def nano_cpus(value):
    require(isinstance(value, str) and re.fullmatch(r'(?:[1-9][0-9]?(?:\.[0-9]{1,2})?|0\.[1-9][0-9]?)', value),
        'quality-cpu-limit')
    number = Decimal(value)
    require(Decimal('0.1') <= number <= 64, 'quality-cpu-limit')
    return int(number * 1000000000)


def validate_state(state, run_id, *, complete=False):
    """Accept only this quality namespace; restore-shaped state is never adapted."""
    state_path(run_id)
    prefix = NAMESPACE + '-' + run_id
    require(state.get('schemaVersion') == 1 and state.get('namespace') == NAMESPACE
        and state.get('runId') == run_id and state.get('prefix') == prefix, 'quality-state-binding')
    require(state.get('phase') in PHASES, 'quality-state-phase')
    require(state.get('applicationDatabase') == 'vectorix_m7c_quality_app_' + run_id + '_test'
        and state.get('vectorDatabase') == 'vectorix_m7c_quality_vectors_' + run_id + '_test', 'quality-test-databases')
    ports = state['ports']
    require(set(ports) == {*SERVICES, 'api', 'web', 'admin'}
        and all(type(value) is int and 1024 < value < 65536 for value in ports.values())
        and len(set(ports.values())) == 8, 'quality-distinct-loopback-ports')
    api, web = 'http://127.0.0.1:' + str(ports['api']), 'http://127.0.0.1:' + str(ports['web'])
    require(state.get('apiOrigin') == api and state.get('webOrigin') == web, 'quality-exact-same-host-origins')
    require(re.fullmatch('[a-f0-9]{40}', state.get('commit', '')) and valid_hash(state.get('lockfileSha256'))
        and valid_hash(state.get('prismaConfigSha256')), 'quality-release-pins')
    require(isinstance(state.get('migrations'), dict) and 1 <= len(state['migrations']) <= 64
        and all(re.fullmatch('[0-9]{14}_[a-z0-9_]{1,80}', key) and valid_hash(value)
            for key, value in state['migrations'].items()), 'quality-migration-pins')
    require(isinstance(state.get('acceptanceSources'), dict) and 1 <= len(state['acceptanceSources']) <= 40
        and all(re.fullmatch('[A-Za-z0-9_.-]{1,100}', key) and valid_hash(value)
            for key, value in state['acceptanceSources'].items()), 'quality-acceptance-source-pins')
    require(valid_hash(state.get('corpusDigest')), 'quality-corpus-pin')
    require(set(state['images']) == set(SERVICES) and all(re.fullmatch('sha256:[a-f0-9]{64}', value)
        for value in state['images'].values()), 'quality-image-pins')
    require(set(state['resourceLimits']) == set(SERVICES), 'quality-resource-budget-set')
    for limit in state['resourceLimits'].values():
        require(set(limit) == {'cpus', 'memoryBytes'}, 'quality-resource-budget-fields')
        nano_cpus(limit['cpus'])
        require(type(limit['memoryBytes']) is int and 64 * 1024 ** 2 <= limit['memoryBytes'] <= 64 * 1024 ** 3,
            'quality-memory-limit')
    require(set(state['builds']) == APP_SERVICES, 'quality-pinned-app-set')
    for service, build in state['builds'].items():
        expected = ROOT / ('apps/' + service + '/dist/index.mjs' if service in {'api', 'workers'}
            else 'apps/web/.next/standalone/apps/web/server.js')
        require(build.get('entry') == str(expected) and valid_hash(build.get('entrySha256'))
            and valid_hash(build.get('treeSha256')) and type(build.get('treeFiles')) is int
            and 1 <= build['treeFiles'] <= 30000, 'quality-production-artifact-pin')
    secret = state['infrastructureSecrets']
    require(set(secret) == {'postgres', 'indexer', 'runtime', 's3Access', 's3Secret'}
        and secret['s3Access'] == 'm7c-quality-' + run_id
        and all(isinstance(secret[key], str) and re.fullmatch('[A-Za-z0-9_-]{32,128}', secret[key])
            for key in ['postgres', 'indexer', 'runtime', 's3Secret']), 'quality-synthetic-secrets')
    environment = state['environment']
    require(set(environment) == ENVIRONMENT_KEYS and all(isinstance(value, str) for value in environment.values()),
        'quality-exact-environment-keys')
    from urllib.parse import urlsplit, unquote
    for key, service, database, role, password in [
        ('DATABASE_URL', 'postgres', 'applicationDatabase', 'postgres', 'postgres'),
        ('VECTOR_DATABASE_URL', 'vector', 'vectorDatabase', 'vectorix_runtime', 'runtime'),
        ('VECTOR_DATABASE_PROVISIONING_URL', 'vector', 'vectorDatabase', 'vectorix_indexer', 'indexer')]:
        value = urlsplit(environment[key])
        require(value.scheme in {'postgres', 'postgresql'} and value.hostname == '127.0.0.1'
            and value.port == ports[service] and value.path == '/' + state[database]
            and not value.query and not value.fragment and unquote(value.username or '') == role
            and unquote(value.password or '') == secret[password], 'quality-exact-database-binding')
    exact = {'NODE_ENV': 'production', 'TZ': 'UTC', 'VECTORIX_TIME_ZONE': 'UTC',
        'BETTER_AUTH_URL': api, 'API_URL': api, 'VECTORIX_WEB_URL': web, 'TRUSTED_ORIGINS': web,
        'ALLOW_ACCOUNT_CREATION': 'true', 'ALLOW_ORGANIZATION_CREATION': 'true',
        'PASSKEY_RP_ID': '127.0.0.1', 'PASSKEY_RP_NAME': 'Vectorix isolated quality acceptance',
        'PASSKEY_ORIGINS': web, 'VECTOR_DATABASE_SCHEMA': 'vector_collections',
        'REDIS_URL': 'redis://127.0.0.1:' + str(ports['redis']), 'VECTORIX_WEB_PUSH_ENABLED': 'false',
        'VECTORIX_DEFAULT_S3_ENDPOINT': 'http://127.0.0.1:' + str(ports['rustfs']),
        'VECTORIX_DEFAULT_S3_REGION': 'us-east-1', 'VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE': 'true',
        'VECTORIX_DEFAULT_S3_BUCKET': 'm7c-quality-' + run_id,
        'VECTORIX_DEFAULT_S3_ACCESS_KEY_ID': secret['s3Access'], 'VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY': secret['s3Secret'],
        'VECTORIX_DEFAULT_OLLAMA_ENDPOINT': 'http://127.0.0.1:' + str(ports['ollama'])}
    exact['VECTORIX_S3_ALLOWED_ENDPOINTS'] = exact['VECTORIX_DEFAULT_S3_ENDPOINT']
    exact['VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS'] = exact['VECTORIX_DEFAULT_OLLAMA_ENDPOINT']
    require(all(environment[key] == value for key, value in exact.items()), 'quality-exact-runtime-bindings')
    require(valid_hash(environment['ENCRYPTION_SECRET']) and re.fullmatch('[A-Za-z0-9_-]{48,128}',
        environment['BETTER_AUTH_SECRET']), 'quality-runtime-secret-shape')
    permitted = set(exact) | {'ENCRYPTION_SECRET', 'BETTER_AUTH_SECRET', 'DATABASE_URL',
        'VECTOR_DATABASE_URL', 'VECTOR_DATABASE_PROVISIONING_URL'}
    require(all(not value for key, value in environment.items() if key not in permitted), 'quality-no-external-defaults')
    resources = state['resources']
    require(isinstance(resources, dict) and set(resources).issubset(SERVICES), 'quality-resource-subset')
    if complete:
        require(set(resources) == set(SERVICES), 'quality-complete-resources-required')
    ids, volumes = [], []
    for service, saved in resources.items():
        require(saved['name'] == prefix + '-' + service and saved['imageId'] == state['images'][service]
            and valid_hash(saved.get('volumeIdentity')), 'quality-saved-resource')
        require(saved['id'] is None or valid_hash(saved['id']), 'quality-saved-container-id')
        if complete:
            require(saved['id'] is not None, 'quality-created-resource-required')
        if service != 'ollama':
            require(saved['volume'] == saved['name'] + '-data', 'quality-new-store-volume')
        else:
            require(saved['volume'] == state['modelVolume']['name']
                and saved['volumeIdentity'] == state['modelVolume']['identity'], 'quality-preserved-model-binding')
        if saved['id'] is not None:
            ids.append(saved['id'])
        volumes.append(saved['volume'])
    require(len(ids) == len(set(ids)) and len(volumes) == len(set(volumes)), 'quality-distinct-resource-identities')
    model = state['modelVolume']
    require(isinstance(model['name'], str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{1,127}', model['name'])
        and not model['name'].startswith(NAMESPACE + '-') and valid_hash(model['identity']), 'quality-existing-model-volume')
    require(set(state['processes']).issubset({'api', 'workers'}) and set(state['dashboardProcesses']).issubset({'web'}),
        'quality-separate-process-sets')
    records = {**state['processes'], **state['dashboardProcesses']}
    if state.get('collectorProcess') is not None:
        records['collector'] = state['collectorProcess']
    for service, saved in records.items():
        entry = Path(__file__).resolve().parent / 'collector.mjs' if service == 'collector' \
            else Path(state['builds'][service]['entry'])
        require(isinstance(saved, dict) and saved.get('service') == service
            and type(saved.get('pid')) is int and saved['pid'] > 1
            and isinstance(saved.get('startTicks'), str) and re.fullmatch('[0-9]{1,30}', saved['startTicks'])
            and isinstance(saved.get('bootId'), str) and re.fullmatch('[a-f0-9-]{36}', saved['bootId'])
            and saved.get('entry') == str(entry) and valid_hash(saved.get('entrySha256'))
            and saved.get('cwd') == str(ROOT if service == 'collector' else entry.parent), 'quality-process-record')
        if service != 'collector':
            require(saved['entrySha256'] == state['builds'][service]['entrySha256'], 'quality-process-build-binding')
    return state


def validate_volume(state, service, value):
    saved = state['resources'][service]
    require(value['Name'] == saved['volume'] and value['Driver'] == 'local'
        and value.get('Options') in [None, {}] and volume_identity(value) == saved['volumeIdentity'],
        'quality-volume-creation-identity')
    if service != 'ollama':
        require(value.get('Labels') == labels(state['runId'], service), 'quality-volume-labels')
    return value


def validate_container(state, service, value, *, running=None):
    """No operation may target a named or replaced container without its exact ID."""
    saved = state['resources'][service]
    require(saved['id'] is not None and value['Id'] == saved['id'] and value['Name'] == '/' + saved['name']
        and value['Image'] == saved['imageId'], 'quality-container-immutable-identity')
    actual_labels = value['Config'].get('Labels') or {}
    require(all(actual_labels.get(key) == content for key, content in labels(state['runId'], service).items()),
        'quality-container-labels')
    host = value['HostConfig']
    require(host['NetworkMode'] == 'bridge' and host['Privileged'] is False
        and not host.get('VolumesFrom') and not host.get('Links'), 'quality-container-isolation')
    require(host['PortBindings'] == {str(SERVICES[service][0]) + '/tcp':
        [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports'][service])}]}, 'quality-container-loopback-port')
    require(host['NanoCpus'] == nano_cpus(state['resourceLimits'][service]['cpus'])
        and host['Memory'] == state['resourceLimits'][service]['memoryBytes'], 'quality-container-resource-limits')
    mounts = value['Mounts']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['Name'] == saved['volume']
        and mounts[0]['Destination'] == SERVICES[service][1] and mounts[0]['RW'] is (service != 'ollama'),
        'quality-exact-volume-mount')
    if running is not None:
        require(value['State']['Running'] is running, 'quality-container-running-state')
    return value


def validate_fixture(fixture, state):
    """Validate final synthetic identities without accepting partial signup journals."""
    require(fixture.get('schemaVersion') == 1 and fixture.get('namespace') == NAMESPACE
        and fixture.get('runId') == state['runId'] and set(fixture['users']) == {'owner', 'reader', 'foreign'},
        'quality-fixture-binding')
    organizations = fixture['organizationIds']
    require(len(organizations) == 2 and len(set(organizations)) == 2
        and all(isinstance(value, str) and SAFE_ID.fullmatch(value) for value in organizations), 'quality-fixture-organizations')
    user_ids, member_ids = [], []
    for role, user in fixture['users'].items():
        require(set(user) == {'userId', 'memberId', 'organizationId', 'email', 'password'}
            and all(isinstance(user[key], str) and SAFE_ID.fullmatch(user[key])
                for key in ['userId', 'memberId', 'organizationId'])
            and user['organizationId'] in organizations
            and user['email'] == 'm7c-quality-' + role + '-' + state['runId'] + '@example.test'
            and isinstance(user['password'], str) and 20 <= len(user['password']) <= 200,
            'quality-fixture-user')
        user_ids.append(user['userId']); member_ids.append(user['memberId'])
    require(len(set(user_ids)) == len(set(member_ids)) == 3
        and fixture['users']['owner']['organizationId'] == fixture['users']['reader']['organizationId']
        and fixture['users']['owner']['organizationId'] != fixture['users']['foreign']['organizationId'],
        'quality-fixture-exact-memberships')
    return fixture


def entry_digest(path):
    """Read only an existing bounded pinned artifact; never follow an outside symlink."""
    value = Path(path)
    require(value.is_file() and value.resolve().is_relative_to(ROOT)
        and value.stat().st_size <= 64 * 1024 ** 2, 'quality-existing-artifact')
    return hashlib.sha256(value.read_bytes()).hexdigest()


def read_state(run_id):
    import json
    return validate_state(json.loads(read_private_bytes(state_path(run_id), 128 * 1024)), run_id)
