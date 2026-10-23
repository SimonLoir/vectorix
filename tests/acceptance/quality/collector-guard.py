"""Independent quality-resource preflight. No resource/database operations on import."""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

STATIC_DRAFT_ONLY = False
SERVICES = {'postgres': (5432, '/var/lib/postgresql'), 'vector': (5432, '/var/lib/postgresql'),
            'redis': (6379, '/data'), 'rustfs': (9000, '/data'), 'ollama': (11434, '/root/.ollama')}

class Refused(Exception):
    pass

def need(value, label):
    if not value:
        raise Refused(label)

def workspace():
    current = Path(__file__).resolve().parent
    for _ in range(7):
        if (current / 'pnpm-workspace.yaml').is_file() and (current / 'packages/db/prisma/schema.prisma').is_file():
            return current
        current = current.parent
    raise Refused('quality-workspace-not-found')

def private_read(filename, root, maximum=128 * 1024):
    relative = filename.relative_to(root)
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in relative.parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor); descriptor = child
        handle = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    with os.fdopen(handle, 'rb') as stream:
        value = os.fstat(stream.fileno())
        need(stat.S_ISREG(value.st_mode) and stat.S_IMODE(value.st_mode) == 0o600 and value.st_uid == os.getuid() and value.st_size <= maximum, 'quality-private-file')
        data = stream.read(maximum + 1); need(len(data) <= maximum, 'quality-private-byte-cap')
        return json.loads(data)

def run(arguments, root, maximum=1024 * 1024):
    env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] if key in os.environ}
    value = subprocess.run(arguments, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=10, check=False)
    need(value.returncode == 0 and len(value.stdout) <= maximum, 'quality-owned-command-refused')
    return value.stdout

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()

def inspect(arguments, root):
    values = json.loads(run(['docker', *arguments], root)); need(len(values) == 1, 'quality-one-resource')
    return values[0]

def preflight(state, fixture, root, run_id):
    need(state['schemaVersion'] == 1 and state['namespace'] == fixture['namespace'] == 'vectorix-m7c-quality'
         and state['runId'] == fixture['runId'] == run_id and state['prefix'] == 'vectorix-m7c-quality-' + run_id,
         'quality-run-binding')
    need(state['phase'] == 'READY_FOR_QUALITY_IMPORT', 'quality-phase')
    database = 'vectorix_m7c_quality_app_' + run_id + '_test'
    need(state['applicationDatabase'] == database and state['vectorDatabase'] == 'vectorix_m7c_quality_vectors_' + run_id + '_test', 'quality-test-databases')
    need(set(state['resources']) == set(SERVICES) and len(set(state['ports'].values())) == 8
         and all(isinstance(value, int) and 1024 < value < 65536 for value in state['ports'].values()), 'quality-ports-resources')
    for service, (inside, mount) in SERVICES.items():
        saved = state['resources'][service]
        need(re.fullmatch('[a-f0-9]{64}', saved['id']) is not None and re.fullmatch('sha256:[a-f0-9]{64}', saved['imageId']) is not None, 'quality-resource-id-shape')
        value = inspect(['inspect', saved['id']], root)
        name = state['prefix'] + '-' + service
        labels = {'vectorix.quality-test.id': run_id, 'vectorix.quality-test.service': service}
        need(saved['name'] == name and value['Name'] == '/' + name and value['Id'] == saved['id']
             and value['Image'] == saved['imageId'] and value['State']['Running'], 'quality-owned-container')
        need(all((value['Config'].get('Labels') or {}).get(key) == content for key, content in labels.items()), 'quality-container-labels')
        host = value['HostConfig']
        need(host['NetworkMode'] == 'bridge' and not host['Privileged'] and not host.get('Links') and not host.get('VolumesFrom'), 'quality-container-isolation')
        need(host['PortBindings'] == {str(inside) + '/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports'][service])}]}, 'quality-loopback-port')
        mounts = value['Mounts']
        need(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['Name'] == saved['volume']
             and mounts[0]['Destination'] == mount and mounts[0]['RW'] is (service != 'ollama'), 'quality-exact-volume-mount')
        volume = inspect(['volume', 'inspect', saved['volume']], root)
        need(volume['Driver'] == 'local' and volume.get('Options') in [None, {}], 'quality-plain-local-volume')
        if service != 'ollama':
            need(saved['volume'] == name + '-data' and volume.get('Labels') == labels, 'quality-owned-store-volume')
        else:
            need(not saved['volume'].startswith(state['prefix']), 'quality-preserved-model-volume')
        identity = hashlib.sha256(canonical({key: volume.get(key) for key in ['Name', 'CreatedAt', 'Driver', 'Labels']})).hexdigest()
        need(identity == saved['volumeIdentity'], 'quality-volume-creation-identity')
    for key, service, expected in [('DATABASE_URL', 'postgres', database), ('VECTOR_DATABASE_URL', 'vector', state['vectorDatabase']), ('VECTOR_DATABASE_PROVISIONING_URL', 'vector', state['vectorDatabase'])]:
        dsn = urlsplit(state['environment'][key])
        need(dsn.scheme in ['postgres', 'postgresql'] and dsn.hostname == '127.0.0.1' and dsn.port == state['ports'][service]
             and dsn.path == '/' + expected and not dsn.query and not dsn.fragment, 'quality-dsn-binding')
    need(run(['git', 'rev-parse', 'HEAD'], root).decode().strip() == state['commit']
         and hashlib.sha256((root / 'pnpm-lock.yaml').read_bytes()).hexdigest() == state['lockfileSha256'], 'quality-release-lock-binding')
    need(set(state['processes']) == {'api', 'workers'}, 'quality-process-set')
    for service, saved in state['processes'].items():
        need(isinstance(saved['pid'], int) and saved['pid'] > 1, 'quality-pid')
        proc = Path('/proc') / str(saved['pid'])
        entry = root / 'apps' / service / 'dist/index.mjs'
        current = (proc / 'stat').read_text(); command = (proc / 'cmdline').read_bytes().split(b'\0')
        need(current[current.rfind(')') + 2:].split()[19] == saved['startTicks']
             and saved['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip()
             and saved['entry'] == str(entry) and str(entry).encode() in command
             and Path(os.readlink(proc / 'cwd')) == entry.parent
             and hashlib.sha256(entry.read_bytes()).hexdigest() == saved['entrySha256'], 'quality-process-command-identity')
        entries = (proc / 'environ').read_bytes().split(b'\0')
        if service == 'api': need(('PORT=' + str(state['ports']['api'])).encode() in entries, 'quality-api-listening-port-config')
        need(b'VECTORIX_QUALITY_RUN=' + run_id.encode() in entries and b'VECTORIX_QUALITY_ROLE=' + service.encode() in entries, 'quality-process-run-markers')
        for key, content in state['environment'].items():
            need((key + '=' + content).encode() in entries, 'quality-process-runtime-environment')
    # Only after every physical/process binding passes: read synthetic IDs with server-enforced read-only mode.
    ids = fixture['organizationIds']; users = fixture['users']
    need(len(ids) == 2 and len(set(ids)) == 2 and all(re.fullmatch('[A-Za-z0-9_-]{1,128}', value) for value in ids), 'quality-fixture-organizations')
    need(set(users) == {'owner', 'reader', 'foreign'}, 'quality-fixture-users')
    for role, user in users.items():
        need(all(re.fullmatch('[A-Za-z0-9_-]{1,128}', user[key]) for key in ['userId', 'memberId', 'organizationId'])
             and user['email'] == 'm7c-quality-' + role + '-' + run_id + '@example.test', 'quality-fixture-user-binding')
    needed_users = sorted(user['userId'] for user in users.values())
    # IDs passed the conservative identifier alphabet, so no quote can enter the fixed read-only query.
    expected_orgs = ','.join("'" + value + "'" for value in ids)
    query = """SELECT json_build_object('organizations',(SELECT json_agg(id ORDER BY id) FROM organization),
       'users',(SELECT json_agg(id ORDER BY id) FROM \"user\"),
       'members',(SELECT json_agg(json_build_object('id',id,'organizationId',\"organizationId\",'userId',\"userId\") ORDER BY id) FROM member),
       'superadmins',(SELECT count(*) FROM \"user\" WHERE \"isSuperAdmin\"),
       'foreignDocuments',(SELECT count(*) FROM \"Document\" WHERE \"organizationId\"<> '""" + users['owner']['organizationId'] + """'),
       'foreignCollections',(SELECT count(*) FROM \"Collection\" WHERE \"organizationId\"<> '""" + users['owner']['organizationId'] + """'),
       'documents',(SELECT count(*) FROM \"Document\"), 'collections',(SELECT count(*) FROM \"Collection\"),
       'outsideOrganizations',(SELECT count(*) FROM organization WHERE id NOT IN (""" + expected_orgs + ")) )"
    result = json.loads(run(['docker', 'exec', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000',
        state['resources']['postgres']['id'], 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', query], root))
    need(result['organizations'] == sorted(ids) and result['users'] == needed_users and result['outsideOrganizations'] == 0
         and result['superadmins'] == 0 and result['foreignDocuments'] == result['foreignCollections'] == 0
         and result['documents'] <= 24 and result['collections'] <= 3, 'quality-only-synthetic-catalog')
    expected_members = sorted([{'id': user['memberId'], 'organizationId': user['organizationId'], 'userId': user['userId']} for user in users.values()], key=lambda row: row['id'])
    need(result['members'] == expected_members, 'quality-exact-current-memberships')
    return {'runId': run_id, 'resourceOwnership': True, 'syntheticCatalog': True, 'databaseReadOnly': True}

def main():
    need(not STATIC_DRAFT_ONLY, 'static-quality-guard-not-approved')
    parser = argparse.ArgumentParser(); parser.add_argument('--state', required=True); parser.add_argument('--run', required=True)
    args = parser.parse_args(); need(re.fullmatch('[a-f0-9]{12}', args.run) is not None, 'quality-run-format')
    root = workspace(); directory = root / 'node_modules/.cache/vectorix' / ('vectorix-m7c-quality-' + args.run)
    info = directory.lstat(); need(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid(), 'quality-private-directory')
    need(args.state == str(directory / 'state.json'), 'quality-exact-state-path')
    state = private_read(directory / 'state.json', root); fixture = private_read(directory / 'fixture.json', root)
    print(json.dumps(preflight(state, fixture, root, args.run), sort_keys=True))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'completed': False, 'diagnostic': error.args[0] if isinstance(error, Refused) else 'sanitized-quality-guard-failure'}), file=sys.stderr)
        raise SystemExit(1) from None
