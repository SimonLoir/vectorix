"""Private restore primitives; imports perform no container/process/database operations."""
from __future__ import annotations

import hashlib
import fcntl
import json
import os
import re
import selectors
import signal
import socket
import stat
import subprocess
import time
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / 'node_modules/.cache/vectorix'
LABEL = 'vectorix.restore-test'
MAX_DUMP = 64 * 1024 * 1024
SERVICES = {
    'postgres': {'port': 5432, 'mount': '/var/lib/postgresql'},
    'vector': {'port': 5432, 'mount': '/var/lib/postgresql'},
    'redis': {'port': 6379, 'mount': '/data'},
    'rustfs': {'port': 9000, 'mount': '/data'},
}
APP_PORTS = {'api': 3101, 'web': 3100, 'admin': 3006}
BASE_ENVIRONMENT_KEYS = {
    'NODE_ENV', 'TZ', 'DATABASE_URL', 'VECTOR_DATABASE_URL', 'VECTOR_DATABASE_PROVISIONING_URL',
    'VECTOR_DATABASE_SCHEMA', 'REDIS_URL', 'BETTER_AUTH_SECRET', 'ENCRYPTION_SECRET',
    'BETTER_AUTH_URL', 'API_URL', 'VECTORIX_WEB_URL', 'TRUSTED_ORIGINS', 'ALLOW_ACCOUNT_CREATION',
    'ALLOW_ORGANIZATION_CREATION', 'ROOT_DOMAIN', 'BETTER_AUTH_COOKIE_NAME', 'BETTER_AUTH_COOKIE_PREFIX',
    'VECTORIX_TIME_ZONE', 'VECTORIX_FEATURE_PROVIDER_URL', 'VECTORIX_DEFAULT_RESEND_API_KEY',
    'VECTORIX_DEFAULT_SMTP_HOST', 'VECTORIX_WEB_PUSH_ENABLED', 'VECTORIX_DEFAULT_S3_ENDPOINT',
    'VECTORIX_DEFAULT_S3_REGION', 'VECTORIX_DEFAULT_S3_BUCKET', 'VECTORIX_DEFAULT_S3_ACCESS_KEY_ID',
    'VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY', 'VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE',
    'VECTORIX_S3_ALLOWED_ENDPOINTS', 'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS', 'VECTORIX_DEFAULT_OLLAMA_ENDPOINT',
    'VECTORIX_DEFAULT_OLLAMA_API_KEY', 'VECTORIX_DEFAULT_COHERE_API_KEY', 'VECTORIX_DEFAULT_VOYAGE_API_KEY',
    'VECTORIX_DEFAULT_OPENAI_API_KEY', 'VECTORIX_DEFAULT_MISTRAL_API_KEY', 'PASSKEY_RP_ID', 'PASSKEY_RP_NAME',
    'PASSKEY_ORIGINS',
}


class GuardError(Exception):
    """A static diagnostic label; never wrap raw command/configuration errors."""


def require(condition, label):
    if not condition:
        raise GuardError(label)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def base_environment():
    # No HOME, .env, inherited credentials, proxy URLs or default SDK configuration.
    return {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] if key in os.environ}


def _parent_descriptor(path):
    """Walk every component with O_NOFOLLOW, including node_modules/cache parents."""
    absolute = Path(path).absolute()
    require(absolute.is_relative_to(CACHE) and '..' not in absolute.parts, 'private-path-outside-cache')
    descriptor = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for component in absolute.relative_to(ROOT).parts[:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor, absolute.name
    except BaseException:
        os.close(descriptor)
        raise


def open_private(path, maximum=8 * 1024 * 1024):
    parent, filename = _parent_descriptor(path)
    try:
        descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600, 'private-file-mode')
        require(info.st_uid == os.getuid(), 'private-file-owner')
        require(0 <= info.st_size <= maximum, 'private-file-byte-bound')
        return os.fdopen(descriptor, 'rb')
    except BaseException:
        os.close(descriptor)
        raise


def private_file(path, maximum=MAX_DUMP):
    with open_private(path, maximum):
        pass
    return path


def read_private_bytes(path, maximum=8 * 1024 * 1024):
    with open_private(path, maximum) as handle:
        value = handle.read(maximum + 1)
        require(len(value) <= maximum, 'private-file-byte-bound')
        return value


def private_directory(path):
    parent, filename = _parent_descriptor(path)
    try:
        descriptor = os.open(filename, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700
                and info.st_uid == os.getuid(), 'private-directory-mode-owner')
    finally:
        os.close(descriptor)
    return path


def read_json(path):
    return json.loads(read_private_bytes(path).decode('utf8'))


def save_json(path, value, exclusive=False):
    parent, filename = _parent_descriptor(path)
    payload = canonical(value) + b'\n'
    require(len(payload) <= 8 * 1024 * 1024, 'private-json-byte-bound')
    temporary = filename if exclusive else filename + '.next'
    try:
        try:
            info = os.stat(filename, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600,
                    'existing-private-json-mode-owner')
        except FileNotFoundError:
            pass
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        if not exclusive:
            os.replace(temporary, filename, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        if not exclusive:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass
        os.close(parent)


@contextmanager
def state_lock():
    """One nofollow/current-UID lock shared by main setup/seed/cutover commands, never queued."""
    parent, filename = _parent_descriptor(CACHE / 'm7c-restore-tool.lock')
    try:
        descriptor = os.open(filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'private-state-lock-mode-owner')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def run(arguments, *, environment=None, input_bytes=None, timeout=30, directory=ROOT):
    """Capture at most 8 MiB at a fixed deadline; command diagnostics never include raw output."""
    result = bounded_stream(arguments, maximum=8 * 1024 * 1024, timeout=timeout, capture=True,
                            environment=environment, input_bytes=input_bytes, directory=directory)
    return result['data']


def bounded_stream(arguments, *, destination=None, maximum=MAX_DUMP, timeout=180, capture=False,
                   environment=None, input_bytes=None, directory=ROOT, allowed_exit_codes=(0,)):
    """Stream at a fixed byte/deadline cap, optionally to an exclusive private file."""
    require(Path(directory).resolve().is_relative_to(ROOT), 'command-working-directory')
    require(isinstance(maximum, int) and 0 < maximum <= MAX_DUMP and 0 < timeout <= 180, 'command-bounds')
    require(allowed_exit_codes == (0,) or (allowed_exit_codes == (0, 1) and capture and destination is None),
            'structured-child-exit-policy')
    descriptor, source, process = None, None, None
    selector = selectors.DefaultSelector()
    try:
        if destination:
            parent, filename = _parent_descriptor(destination)
            try:
                descriptor = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
            finally:
                os.close(parent)
        if input_bytes is not None:
            require(isinstance(input_bytes, bytes) and len(input_bytes) <= 8 * 1024 * 1024, 'command-input-bound')
            source = tempfile.TemporaryFile(mode='w+b')
            source.write(input_bytes)
            source.seek(0)
        process = subprocess.Popen(arguments, cwd=directory, env=environment if environment is not None else base_environment(),
                                   stdin=source if source is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        checksum, size, started = hashlib.sha256(), 0, time.monotonic()
        captured = [] if capture else None
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            require(time.monotonic() - started <= timeout, 'stream-deadline')
            for key, _ in selector.select(timeout=min(0.25, timeout)):
                part = os.read(key.fd, 64 * 1024)
                if not part:
                    selector.unregister(key.fileobj)
                    break
                size += len(part)
                require(size <= maximum, 'stream-byte-bound')
                checksum.update(part)
                if captured is not None:
                    captured.append(part)
                if descriptor is not None:
                    offset = 0
                    while offset < len(part):
                        offset += os.write(descriptor, part[offset:])
        exit_code = process.wait(timeout=max(0.01, timeout - (time.monotonic() - started)))
        require(exit_code in allowed_exit_codes, 'stream-command-failed')
        if descriptor is not None:
            os.fsync(descriptor)
        result = {'bytes': size, 'sha256': checksum.hexdigest(), 'exitCode': exit_code}
        if captured is not None:
            result['data'] = b''.join(captured)
        return result
    finally:
        selector.close()
        if process is not None:
            if process.stdout:
                process.stdout.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        if descriptor is not None:
            os.close(descriptor)
        if source is not None:
            source.close()


def state_path(run_id):
    require(re.fullmatch('[a-f0-9]{12}', run_id) is not None, 'run-format')
    return CACHE / ('vectorix-m7c-restore-' + run_id) / 'state.json'


def validate_state(state, run_id):
    require(state['version'] == 1 and state['runId'] == run_id, 'state-version-run')
    prefix = 'vectorix-m7c-restore-' + run_id
    require(state['prefix'] == prefix, 'state-prefix')
    require(state['applicationDatabase'] == 'vectorix_m7c_app_' + run_id + '_test', 'application-test-database')
    require(state['vectorDatabase'] == 'vectorix_m7c_vectors_' + run_id + '_test', 'vector-test-database')
    require(state['bootstrapDatabase'] == 'vectorix_m7c_bootstrap_' + run_id + '_test', 'bootstrap-test-database')
    require(set(state['environment']) == BASE_ENVIRONMENT_KEYS, 'exact-runtime-environment-whitelist')
    require(set(state['ports']) == {*SERVICES, 'ollama'}, 'exact-service-port-keys')
    require(set(state['images']) == {*SERVICES, 'ollama'}, 'exact-service-image-keys')
    require(all(re.fullmatch(r'sha256:[a-f0-9]{64}', value) for value in state['images'].values()), 'image-id-format')
    model_name = state['modelVolume']['name']
    require(isinstance(model_name, str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{1,127}', model_name) is not None
            and not model_name.startswith(prefix), 'explicit-preserved-model-volume-name')
    secret = state['infrastructureSecrets']
    require(set(secret) == {'postgres', 'indexer', 'runtime', 's3Access', 's3Secret'}, 'exact-infrastructure-secret-keys')
    require(secret['s3Access'] == 'm7c-' + run_id, 'owned-s3-access-identity')
    for key in ['postgres', 'indexer', 'runtime', 's3Secret']:
        require(re.fullmatch(r'[A-Za-z0-9_-]{32,128}', secret[key]) is not None, 'synthetic-secret-shape')
    for key, service, database in [
        ('DATABASE_URL', 'postgres', 'applicationDatabase'),
        ('VECTOR_DATABASE_URL', 'vector', 'vectorDatabase'),
        ('VECTOR_DATABASE_PROVISIONING_URL', 'vector', 'vectorDatabase'),
    ]:
        value = urlsplit(state['environment'][key])
        require(value.scheme in ['postgres', 'postgresql'] and value.hostname == '127.0.0.1', 'database-loopback')
        require(value.port == state['ports'][service] and value.path == '/' + state[database], 'database-binding')
        require(not value.query and not value.fragment, 'database-dsn-shape')
        from urllib.parse import unquote
        expected_user, expected_secret = {'DATABASE_URL': ('postgres', 'postgres'),
            'VECTOR_DATABASE_URL': ('vectorix_runtime', 'runtime'),
            'VECTOR_DATABASE_PROVISIONING_URL': ('vectorix_indexer', 'indexer')}[key]
        require(unquote(value.username or '') == expected_user and unquote(value.password or '') == secret[expected_secret], 'database-credential-binding')
    for key, service, scheme in [('REDIS_URL', 'redis', 'redis'),
                                ('VECTORIX_DEFAULT_S3_ENDPOINT', 'rustfs', 'http'),
                                ('VECTORIX_DEFAULT_OLLAMA_ENDPOINT', 'ollama', 'http')]:
        value = urlsplit(state['environment'][key])
        require(value.scheme == scheme and value.hostname == '127.0.0.1', 'service-loopback')
        require(value.port == state['ports'][service] and value.path in ['', '/'], 'service-port-binding')
        require(not value.query and not value.fragment and not value.username and not value.password, 'service-url-shape')
    require(state['environment']['VECTOR_DATABASE_SCHEMA'] == 'vector_collections', 'vector-schema')
    require(state['environment']['VECTORIX_S3_ALLOWED_ENDPOINTS'] == state['environment']['VECTORIX_DEFAULT_S3_ENDPOINT'], 's3-allowlist')
    require(state['environment']['VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS'] == state['environment']['VECTORIX_DEFAULT_OLLAMA_ENDPOINT'], 'model-allowlist')
    require(state['environment']['VECTORIX_WEB_PUSH_ENABLED'] == 'false', 'no-push')
    exact = {'NODE_ENV': 'production', 'TZ': 'UTC', 'VECTORIX_TIME_ZONE': 'UTC',
        'BETTER_AUTH_URL': 'http://localhost:3101', 'API_URL': 'http://localhost:3101',
        'VECTORIX_WEB_URL': 'http://localhost:3100', 'TRUSTED_ORIGINS': 'http://localhost:3100,http://localhost:3006',
        'PASSKEY_RP_ID': 'localhost', 'PASSKEY_ORIGINS': 'http://localhost:3100,http://localhost:3006',
        'ALLOW_ACCOUNT_CREATION': 'true', 'ALLOW_ORGANIZATION_CREATION': 'true',
        'VECTORIX_DEFAULT_S3_REGION': 'us-east-1', 'VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE': 'true',
        'VECTORIX_DEFAULT_S3_BUCKET': 'm7c-' + run_id + '-platform',
        'VECTORIX_DEFAULT_S3_ACCESS_KEY_ID': secret['s3Access'], 'VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY': secret['s3Secret']}
    require(all(state['environment'][key] == value for key, value in exact.items()), 'exact-owned-runtime-bindings')
    require(re.fullmatch('[a-f0-9]{64}', state['environment']['ENCRYPTION_SECRET']) is not None, 'encryption-key-shape')
    require(re.fullmatch('[A-Za-z0-9_-]{48,128}', state['environment']['BETTER_AUTH_SECRET']) is not None, 'auth-secret-shape')
    for key in ['VECTORIX_DEFAULT_RESEND_API_KEY', 'VECTORIX_DEFAULT_SMTP_HOST',
                'VECTORIX_DEFAULT_COHERE_API_KEY', 'VECTORIX_DEFAULT_VOYAGE_API_KEY',
                'VECTORIX_DEFAULT_OPENAI_API_KEY', 'VECTORIX_DEFAULT_MISTRAL_API_KEY',
                'VECTORIX_DEFAULT_OLLAMA_API_KEY', 'ROOT_DOMAIN', 'BETTER_AUTH_COOKIE_NAME',
                'BETTER_AUTH_COOKIE_PREFIX', 'VECTORIX_FEATURE_PROVIDER_URL']:
        require(state['environment'].get(key, '') == '', 'no-external-default-provider')
    require(state['buckets'] == ['m7c-' + run_id + '-platform', 'm7c-' + run_id + '-organization'], 'ordered-owned-buckets')
    require(len(set(state['ports'].values())) == len(state['ports']), 'distinct-loopback-ports')
    require(all(isinstance(value, int) and 1024 < value < 65536 for value in state['ports'].values()), 'valid-loopback-ports')
    require(not set(state['ports'].values()) & set(APP_PORTS.values()), 'infrastructure-app-port-separation')
    require(set(state['resources']) == {'source', 'target'}, 'exact-resource-sides')
    for side, entries in state['resources'].items():
        require(set(entries).issubset(SERVICES), 'exact-resource-services')
        for service, value in entries.items():
            require(value['volume'] == prefix + '-' + side + '-' + service + '-data', 'resource-volume-name')
            require(re.fullmatch('[a-f0-9]{64}', value['volumeIdentity']) is not None, 'resource-volume-identity-shape')
            require(value['id'] is None or re.fullmatch('[a-f0-9]{64}', value['id']) is not None, 'resource-container-identity-shape')
    for service in SERVICES:
        if service in state['resources']['source'] and service in state['resources']['target']:
            source, target = state['resources']['source'][service], state['resources']['target'][service]
            require(source['volume'] != target['volume'] and source['volumeIdentity'] != target['volumeIdentity'], 'distinct-source-target-volumes')
            require(source['id'] is None or target['id'] is None or source['id'] != target['id'], 'distinct-source-target-containers')
    return state


def metadata(name, kind='container'):
    value = json.loads(run(['docker', kind, 'inspect', name]))
    require(len(value) == 1, 'one-owned-resource')
    return value[0]


def labels(state, side, service):
    return {LABEL + '.id': state['runId'], LABEL + '.side': side, LABEL + '.service': service}


def volume_identity(value):
    # Docker local volumes have no immutable ID: pin creation metadata and exact labels.
    return digest(canonical({key: value.get(key) for key in ['Name', 'CreatedAt', 'Driver', 'Labels']}))


def owned_volume(state, side, service):
    saved = state['resources'][side][service]
    value = metadata(saved['volume'], 'volume')
    require(value['Name'] == state['prefix'] + '-' + side + '-' + service + '-data', 'volume-name')
    require(value['Driver'] == 'local' and value.get('Options') in [None, {}], 'plain-local-volume')
    require(value.get('Labels') == labels(state, side, service), 'volume-labels')
    require(volume_identity(value) == saved['volumeIdentity'], 'volume-creation-identity')
    return value


def owned_container(state, side, service, running=None):
    saved = state['resources'][side][service]
    name = state['prefix'] + '-' + side + '-' + service
    value = metadata(name)
    require(value['Id'] == saved['id'] and value['Name'] == '/' + name, 'container-identity')
    require(value['Image'] == state['images'][service], 'pinned-local-image')
    actual_labels = value['Config'].get('Labels') or {}
    require(all(actual_labels.get(key) == content for key, content in labels(state, side, service).items()), 'container-labels')
    require(value['HostConfig']['Privileged'] is False and value['HostConfig']['NetworkMode'] == 'bridge', 'container-isolation')
    require(not value['HostConfig'].get('VolumesFrom') and not value['HostConfig'].get('Links'), 'no-inherited-mounts-links')
    bindings = value['HostConfig']['PortBindings']
    expected_port = str(SERVICES[service]['port']) + '/tcp'
    require(set(bindings) == {expected_port}, 'one-bound-container-port')
    require(bindings[expected_port] == [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports'][service])}], 'pinned-loopback-binding')
    mounts = value['Mounts']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['RW'] is True, 'one-owned-writable-volume')
    require(mounts[0]['Name'] == saved['volume'] and mounts[0]['Destination'] == SERVICES[service]['mount'], 'owned-volume-mount')
    owned_volume(state, side, service)
    if running is not None:
        require(value['State']['Running'] is running, 'container-running-state')
    return value


def owned_model(state, running=None):
    saved = state['modelContainer']
    value = metadata(saved['name'])
    require(saved['name'] == state['prefix'] + '-ollama' and value['Name'] == '/' + saved['name'], 'owned-model-name')
    require(value['Id'] == saved['id'] and value['Image'] == state['images']['ollama'], 'owned-model-container-image')
    actual_labels = value['Config'].get('Labels') or {}
    require(all(actual_labels.get(key) == content for key, content in labels(state, 'shared', 'ollama').items()), 'owned-model-labels')
    require(value['HostConfig']['NetworkMode'] == 'bridge' and not value['HostConfig']['Privileged'], 'owned-model-network')
    require(value['HostConfig']['PortBindings'] == {'11434/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports']['ollama'])}]}, 'owned-model-port')
    mounts = value['Mounts']
    model_name = state['modelVolume']['name']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['Name'] == model_name
            and mounts[0]['Destination'] == '/root/.ollama' and mounts[0]['RW'] is False, 'preserved-read-only-model-mount')
    model = metadata(model_name, 'volume')
    require(model['Driver'] == 'local' and model.get('Options') in [None, {}], 'plain-local-model-volume')
    require(volume_identity(model) == state['modelVolume']['identity'], 'preserved-model-volume-identity')
    if running is not None:
        require(value['State']['Running'] is running, 'owned-model-running-state')
    return value


def process_identity(pid):
    try:
        text = Path('/proc/' + str(pid) + '/stat').read_text()
        fields = text[text.rfind(')') + 2:].split()
        if fields[0] in ['Z', 'X', 'x']:
            return None
        environment = Path('/proc/' + str(pid) + '/environ').read_bytes().split(b'\0')
        markers = {}
        for field in ['VECTORIX_RESTORE_RUN', 'VECTORIX_RESTORE_SIDE']:
            matches = [value[len(field) + 1:].decode('ascii') for value in environment if value.startswith(field.encode() + b'=')]
            markers[field] = matches[0] if len(matches) == 1 else None
        return {'startTicks': fields[19],
                'command': Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0'),
                'cwd': Path(os.readlink('/proc/' + str(pid) + '/cwd')), 'markers': markers}
    except (FileNotFoundError, ProcessLookupError):
        return None


def process_alive(saved):
    if saved['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        return False  # Never signal a recycled PID after a host boot.
    current = process_identity(saved['pid'])
    if not current or current['startTicks'] != saved['startTicks']:
        return False
    entry = Path(saved['entry'])
    exact_entry = str(entry).encode() in current['command']
    next_entry = current['command'][0].startswith(b'next-server ') and current['cwd'] == entry.parent
    require(exact_entry or next_entry, 'owned-process-command')
    require(current['markers'] == {'VECTORIX_RESTORE_RUN': saved['runId'], 'VECTORIX_RESTORE_SIDE': saved['side']}, 'owned-process-run-markers')
    return True


def no_apps(state):
    for saved in state['processes'].values():
        require(not process_alive(saved), 'application-still-running')
    for port in APP_PORTS.values():
        with socket.socket() as connection:
            connection.settimeout(0.2)
            require(connection.connect_ex(('127.0.0.1', port)) != 0, 'application-port-still-listening')


def stop_apps(state, only=None):
    for name, saved in list(state['processes'].items()):
        if only and name != only:
            continue
        require(name in ['api', 'web', 'admin', 'workers'] and saved['entry'] == state['builds'][name]['entry']
                and saved['runId'] == state['runId'] and saved['side'] in ['source', 'target'], 'saved-process-owned-build')
        if process_alive(saved):
            os.kill(saved['pid'], signal.SIGTERM)
            deadline = time.monotonic() + 55
            while process_alive(saved) and time.monotonic() < deadline:
                time.sleep(0.2)
            require(not process_alive(saved), 'graceful-stop-timeout-no-forced-kill')
        del state['processes'][name]


def database_command(state, side, service, tool, *arguments):
    owned_container(state, side, service, running=True)
    database = state['applicationDatabase' if service == 'postgres' else 'vectorDatabase']
    return ['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20000',
            state['resources'][side][service]['id'], tool,
            '-U', 'postgres', '-d', database, *arguments]


def sql_json(state, side, service, query, *, bootstrap=False):
    require(query.lstrip().upper().startswith(('SELECT', 'WITH')), 'read-only-sql-entry')
    arguments = database_command(state, side, service, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query)
    if bootstrap:
        arguments[arguments.index('-d') + 1] = state['bootstrapDatabase']
    result = run(arguments, timeout=20).strip()
    try:
        return json.loads(result)
    except json.JSONDecodeError:
        raise GuardError('read-only-json-response-shape') from None


def name(identifier):
    require(re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,62}', identifier) is not None, 'sql-identifier')
    return '"' + identifier + '"'
