"""Populated application-DB restore regression inside an owned catalog run.

The caller creates the source container and loads only synthetic fixtures. This
check creates one separate, network-isolated target with the source's immutable
image ID. It never reads .env or adopts a database/container by name alone.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/acceptance/restore'))
from m7c_restore_archive import normalized_schema
from m7c_restore_common import (
    CACHE, GuardError, base_environment, bounded_stream, canonical, digest,
    open_private, read_private_bytes, require, run, save_json,
)

LABEL = 'vectorix.catalog-test'
DATABASE = 'vectorix_upgrade_test'
BOOTSTRAP = 'vectorix_function_restore_bootstrap_test'
MAX_ARCHIVE = 8 * 1024 * 1024


def identifier(value):
    """Only catalog-returned public identifiers become SQL syntax."""
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', value),
            'restore-regression-identifier')
    return '"' + value + '"'


def inspected(container):
    rows = json.loads(run(['docker', 'inspect', container], timeout=15))
    require(isinstance(rows, list) and len(rows) == 1, 'restore-regression-one-container')
    return rows[0]


def validate_container(value, prefix, side, *, source_image=None, allow_stopped=False):
    """Bind every operation/removal to this caller's exact synthetic run."""
    require(re.fullmatch(r'vectorix-catalog-[0-9]{1,5}-[0-9]{1,10}', prefix), 'restore-regression-prefix')
    require(side in ['source', 'target'], 'restore-regression-side')
    expected = prefix + ('-postgres' if side == 'source' else '-restore-postgres')
    require(value['Name'] == '/' + expected and value['Config'].get('Labels', {}).get(LABEL) == prefix,
            'restore-regression-container-ownership')
    require(re.fullmatch(r'[a-f0-9]{64}', value['Id'])
            and (allow_stopped or value['State']['Running'] is True),
            'restore-regression-running-container')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', value['Image']), 'restore-regression-image-id')
    require(not value['HostConfig']['Privileged'], 'restore-regression-unprivileged-container')
    mounts = value['Mounts']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume'
            and mounts[0]['Destination'] == '/var/lib/postgresql' and mounts[0]['RW'] is True,
            'restore-regression-dedicated-volume')
    if side == 'target':
        require(value['Image'] == source_image and value['HostConfig']['NetworkMode'] == 'none'
                and not value['HostConfig'].get('PortBindings'), 'restore-regression-isolated-target')
    return mounts[0]['Name']


def database_command(container, database, tool, *arguments):
    require(database in [DATABASE, BOOTSTRAP], 'restore-regression-test-database')
    return ['docker', 'exec', '-e',
            'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=20000 -c timezone=UTC',
            container, tool, '-U', 'postgres', '-d', database, *arguments]


def query(container, statement, *, database=DATABASE):
    require(statement.lstrip().upper().startswith('SELECT'), 'restore-regression-read-query')
    raw = run(database_command(container, database, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement), timeout=30)
    return json.loads(raw)


def snapshot(container, *, schema_evidence=None):
    """Hash every user row and full schema, with explicit bounded coverage."""
    clients = query(container, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()")
    require(clients == 0, 'restore-regression-no-other-client')
    unsupported = query(container, """SELECT json_build_object(
      'largeObjects',(SELECT count(*) FROM pg_largeobject_metadata),
      'tablespaces',(SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')),
      'otherRelations',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
        AND (n.nspname<>'public' OR c.relkind IN ('m','f','p','S'))))""")
    require(all(value == 0 for value in unsupported.values()), 'restore-regression-supported-schema')
    tables = query(container, """SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]'::json)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'""")
    require(1 <= len(tables) <= 128, 'restore-regression-table-count')
    counts, rows = [], []
    for table in tables:
        relation = 'public.' + identifier(table)
        # identifier() excludes quotes, so the relation label is also a safe literal.
        counts.append("SELECT '" + table + "' AS name,count(*) AS rows FROM " + relation)
        rows.append("SELECT '" + table + "' AS relation,to_jsonb(r)::text AS value FROM " + relation + ' r')
    totals = query(container, 'SELECT json_agg(row_to_json(t) ORDER BY name) FROM (' + ' UNION ALL '.join(counts) + ') t')
    require(sum(row['rows'] for row in totals) <= 50000, 'restore-regression-row-count')
    copy = 'COPY (SELECT relation,value FROM (' + ' UNION ALL '.join(rows) + ') r ORDER BY relation,value) TO STDOUT'
    require(len(copy) <= 65536, 'restore-regression-query-bound')
    row_hash = bounded_stream(database_command(container, DATABASE, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', copy),
                              maximum=64 * 1024 * 1024, timeout=60)
    schema = bounded_stream(database_command(container, DATABASE, 'pg_dump', '--schema-only', '--create'),
                            maximum=8 * 1024 * 1024, timeout=60, capture=True)
    normalized = normalized_schema(schema['data'])
    if schema_evidence:
        save_json(schema_evidence, {'normalizedSchema': normalized.decode('utf8')}, exclusive=True)
    return {'tables': totals, 'rowsSha256': row_hash['sha256'], 'rowBytes': row_hash['bytes'],
            'schemaSha256': digest(normalized)}


def fixture_coverage(container):
    """Empty JSON or historical null offsets cannot silently weaken this test."""
    result = query(container, """SELECT json_build_object(
      'populatedTelemetry',(SELECT count(*) FROM public."RagOperationalHour" WHERE "organizationId"='parent-schema-org'
        AND "phaseStats"<>'{}'::jsonb AND "failureCounts"<>'{}'::jsonb),
      'liveSemanticPlan',(SELECT count(*) FROM public."SemanticChunkPlan" WHERE "indexedDocumentId"='sql-path-semantic-candidate'
        AND state<>'CLEANED' AND jsonb_array_length("unitRanges")>0),
      'canonicalParents',(SELECT count(*) FROM public."Chunk" WHERE "organizationId"='parent-schema-org' AND kind='PARENT'
        AND "startOffset" IS NOT NULL AND "endOffset" IS NOT NULL),
      'linkedChildren',(SELECT count(*) FROM public."Chunk" WHERE "organizationId"='parent-schema-org' AND kind='CHILD'
        AND "parentId" IS NOT NULL AND "startOffset" IS NOT NULL AND "endOffset" IS NOT NULL))""")
    require(all(isinstance(value, int) and value > 0 for value in result.values()), 'restore-regression-nonempty-path-coverage')
    return result


def restore_archive(target, archive):
    """Use ordinary pg_restore; retain bounded private error bytes on failure."""
    data = read_private_bytes(archive, MAX_ARCHIVE)
    # The shell text is fixed, contains no inputs/secrets and only redirects the
    # native diagnostic into the same bounded private capture as stdout.
    command = 'exec pg_restore -U postgres -d vectorix_function_restore_bootstrap_test --create --exit-on-error 2>&1'
    result = bounded_stream(['docker', 'exec', '-i', target, 'sh', '-c', command], input_bytes=data,
                            maximum=128 * 1024, timeout=180, capture=True, allowed_exit_codes=(0, 1))
    if result['exitCode'] != 0:
        descriptor = os.open(archive.parent / 'restore-error-private.log', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(result['data'])
        raise GuardError('populated-database-restore-failed')


def main(prefix):
    source = inspected(prefix + '-postgres')
    source_volume = validate_container(source, prefix, 'source')
    roles = query(source['Id'], "SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_roles WHERE rolname !~ '^pg_'")
    require(roles == ['postgres'], 'restore-regression-only-catalog-role')
    coverage = fixture_coverage(source['Id'])
    CACHE.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(CACHE.resolve() == CACHE and CACHE.is_dir() and not CACHE.is_symlink(), 'restore-regression-cache-directory')
    directory = Path(tempfile.mkdtemp(prefix='catalog-function-restore-', dir=CACHE))
    os.chmod(directory, 0o700)
    archive = directory / 'application.dump'
    target_id = None
    succeeded = False
    try:
        baseline = snapshot(source['Id'], schema_evidence=directory / 'source-schema-private.json')
        save_json(directory / 'source-manifest.json', baseline, exclusive=True)
        dumped = bounded_stream(database_command(source['Id'], DATABASE, 'pg_dump', '-Fc', '--create'),
                                destination=archive, maximum=MAX_ARCHIVE, timeout=90)
        require(snapshot(source['Id']) == baseline, 'restore-regression-source-stable-after-dump')
        created = run(['docker', 'create', '--pull=never', '--name', prefix + '-restore-postgres',
                       '--label', LABEL + '=' + prefix, '--network', 'none',
                       '-e', 'POSTGRES_PASSWORD=catalog-restore-test-only-password', '-e', 'POSTGRES_DB=' + BOOTSTRAP,
                       source['Image']], timeout=60).decode().strip()
        require(re.fullmatch(r'[a-f0-9]{64}', created), 'restore-regression-created-target-id')
        target_id = created
        target_volume = validate_container(inspected(target_id), prefix, 'target', source_image=source['Image'], allow_stopped=True)
        require(target_volume != source_volume, 'restore-regression-distinct-target-volume')
        # Record the returned exact ID before starting. A start failure is still
        # cleaned through that ID; an uncertain create is never adopted by name.
        run(['docker', 'start', target_id], timeout=30)
        validate_container(inspected(target_id), prefix, 'target', source_image=source['Image'])
        deadline = time.monotonic() + 60
        ready = False
        while time.monotonic() < deadline:
            result = subprocess.run(['docker', 'exec', target_id, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', BOOTSTRAP],
                                    env=base_environment(), cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if result.returncode == 0:
                ready = True
                break
            time.sleep(0.2)
        require(ready, 'restore-regression-target-ready')
        databases = query(target_id, "SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE NOT datistemplate", database=BOOTSTRAP)
        require(databases == sorted(['postgres', BOOTSTRAP]), 'restore-regression-target-empty-bootstrap')
        restore_archive(target_id, archive)
        restored = snapshot(target_id, schema_evidence=directory / 'restored-schema-private.json')
        save_json(directory / 'restored-manifest.json', restored, exclusive=True)
        restored_coverage = fixture_coverage(target_id)
        if restored != baseline or restored_coverage != coverage:
            print(json.dumps({'restoredParity': False, 'sameTablesAndCounts': restored['tables'] == baseline['tables'],
                              'sameRowBytes': restored['rowBytes'] == baseline['rowBytes'],
                              'sameRowsSha256': restored['rowsSha256'] == baseline['rowsSha256'],
                              'sameSchemaSha256': restored['schemaSha256'] == baseline['schemaSha256'],
                              'sameFixtureCoverage': restored_coverage == coverage}, sort_keys=True))
            raise GuardError('restore-regression-full-row-schema-parity')
        require(snapshot(source['Id']) == baseline, 'restore-regression-source-unchanged')
        proof = {'database': DATABASE, 'ordinaryCreateRestore': True, 'sourceAndTargetImageIdentical': True,
                 'distinctVolumes': True, 'schemaSha256': baseline['schemaSha256'], 'rowsSha256': baseline['rowsSha256'],
                 'tables': len(baseline['tables']), 'rows': sum(row['rows'] for row in baseline['tables']),
                 'rowBytes': baseline['rowBytes'], 'archiveBytes': dumped['bytes'], 'archiveSha256': dumped['sha256'],
                 'fixtureCoverage': coverage, 'browserAcceptance': False}
        save_json(directory / 'proof.json', proof, exclusive=True)
        print(json.dumps(proof, sort_keys=True))
        succeeded = True
    finally:
        if target_id:
            validate_container(inspected(target_id), prefix, 'target', source_image=source['Image'], allow_stopped=True)
            run(['docker', 'rm', '-fv', target_id], timeout=60)
        if succeeded:
            # Only exact files created in this private mkdtemp are removed.
            with open_private(archive, MAX_ARCHIVE):
                pass
            archive.unlink()
            for filename in ['proof.json', 'source-schema-private.json', 'restored-schema-private.json', 'source-manifest.json', 'restored-manifest.json']:
                with open_private(directory / filename):
                    pass
                (directory / filename).unlink()
            directory.rmdir()


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2, 'restore-regression-prefix-required')
        main(sys.argv[1])
    except Exception as error:
        label = error.args[0] if isinstance(error, GuardError) else 'sanitized-restore-regression-failure'
        print(json.dumps({'completed': False, 'diagnostic': label}), file=sys.stderr)
        raise SystemExit(1) from None
