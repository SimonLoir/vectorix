"""Bounded read-only manifests for the exact owned restore fixture; no resource operations on import."""
import re

from m7c_restore_common import (
    MAX_DUMP, bounded_stream, canonical, database_command, digest, name, require, sql_json,
)
from m7c_restore_archive import MAX_SCHEMA, normalized_schema


def fixture(state, value):
    require(value['runId'] == state['runId'] and value['prefix'] == state['prefix'], 'fixture-run-prefix')
    for field, minimum, maximum in [('organizationIds', 2, 2), ('collectionIds', 1, 3),
                                    ('documentIds', 1, 4), ('userIds', 2, 16)]:
        rows = value[field]
        require(minimum <= len(rows) <= maximum and len(rows) == len(set(rows)), 'fixture-identifier-count')
        require(all(isinstance(row, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', row) for row in rows), 'fixture-identifier-shape')
    return value


def role_manifest(state, side, service, *, bootstrap=False, passwords=True):
    rows = sql_json(state, side, service, """SELECT coalesce(json_agg(row_to_json(r) ORDER BY rolname),'[]'::json)
      FROM (SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,
        rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles WHERE rolname !~ '^pg_') r""", bootstrap=bootstrap)
    expected = ['postgres'] if service == 'postgres' else ['postgres', 'vectorix_indexer', 'vectorix_runtime']
    require(sorted(row['rolname'] for row in rows) == sorted(expected), 'only-reviewed-database-roles')
    for row in rows:
        if row['rolname'] != 'postgres':
            require(not any(row[key] for key in ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls']), 'least-privilege-vector-role')
        require(row['rolconfig'] is None and row['rolvaliduntil'] is None and row['rolconnlimit'] == -1,
                'no-unhandled-role-settings')
    memberships = sql_json(state, side, service, """SELECT count(*) FROM pg_auth_members m
       JOIN pg_roles a ON a.oid=m.roleid JOIN pg_roles b ON b.oid=m.member
       WHERE a.rolname !~ '^pg_' OR b.rolname !~ '^pg_'""", bootstrap=bootstrap)
    require(memberships == 0, 'no-unhandled-custom-role-memberships')
    if passwords:
        protected = sql_json(state, side, service, """SELECT coalesce(json_agg(json_build_object('name',rolname,'password',rolpassword)
           ORDER BY rolname),'[]'::json) FROM pg_authid WHERE rolname !~ '^pg_'""", bootstrap=bootstrap)
        for row in rows:
            source = next(value for value in protected if value['name'] == row['rolname'])
            require(isinstance(source['password'], str) and source['password'].startswith('SCRAM-SHA-256$'), 'reviewed-scram-role-secret')
            row['passwordSha256'] = digest(source['password'].encode())
    return rows


def verify_fixture_ids(state, side, accepted):
    for table, key in [('organization', 'organizationIds'), ('user', 'userIds')]:
        rows = sql_json(state, side, 'postgres', 'SELECT coalesce(json_agg(id ORDER BY id),\'[]\'::json) FROM ' + name(table))
        require(rows == sorted(accepted[key]), 'exact-owned-fixture-' + key)
    for table, key in [('Collection', 'collectionIds'), ('Document', 'documentIds')]:
        rows = sql_json(state, side, 'postgres', 'SELECT coalesce(json_agg(id ORDER BY id),\'[]\'::json) FROM ' + name(table))
        require(rows == sorted(accepted[key]), 'exact-owned-fixture-' + key)
    counts = sql_json(state, side, 'postgres', '''SELECT json_build_object(
       'versions',(SELECT count(*) FROM "DocumentVersion"),
       'children',(SELECT count(*) FROM "Chunk" WHERE kind='CHILD'),
       'parents',(SELECT count(*) FROM "Chunk" WHERE kind='PARENT'),
       'inFlightWork',(SELECT count(*) FROM "EmbeddingWorkAttempt" WHERE state IN ('RESERVED','IN_FLIGHT')),
       'processingIndex',(SELECT count(*) FROM "IndexTask" WHERE status='PROCESSING'),
       'processingIngestion',(SELECT count(*) FROM "DocumentIngestion" WHERE status='PROCESSING'),
       'uploading',(SELECT count(*) FROM "DocumentIngestion" WHERE status='UPLOADING'),
       'processingCleanup',(SELECT count(*) FROM "DocumentCleanup" WHERE status='PROCESSING'),
       'processingNotifications',(SELECT count(*) FROM "VectorixNotificationDelivery" WHERE status='PROCESSING'),
       'externalIndexProfiles',(SELECT count(*) FROM "CollectionConfigRevision" WHERE provider<>'OLLAMA'))''')
    require(counts['versions'] <= 8 and counts['children'] <= 500 and counts['parents'] <= 500, 'bounded-fixture-layout')
    require(all(counts[key] == 0 for key in ['inFlightWork', 'processingIndex', 'processingIngestion', 'processingCleanup',
                                          'processingNotifications', 'uploading', 'externalIndexProfiles']),
            'clean-quiescence-no-inflight-work')
    return counts


def schema_categories(raw):
    """Hashes make ACL/default-privilege/function/trigger/index/constraint coverage explicit."""
    normalized = normalized_schema(raw)
    sections, category = {}, 'PREAMBLE'
    for line in normalized.splitlines(keepends=True):
        match = re.match(rb'-- Name: .*; Type: ([A-Z ]{1,64}); Schema: .*; Owner: .*', line)
        if match:
            category = match[1].decode('ascii')
        sections.setdefault(category, bytearray()).extend(line)
    require(len(sections) <= 64, 'schema-category-bound')
    return {'sha256': digest(normalized), 'bytes': len(normalized),
            'categories': {category: digest(bytes(value)) for category, value in sorted(sections.items())}}


def database_manifest(state, side, service):
    # Each relation is counted before copying; no raw row/credential/content is saved or emitted.
    connections = sql_json(state, side, service, """SELECT count(*) FROM pg_stat_activity
       WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()""")
    require(connections == 0, 'no-other-database-client')
    unsupported = sql_json(state, side, service, """SELECT json_build_object(
       'largeObjects',(SELECT count(*) FROM pg_largeobject_metadata),
       'customTablespaces',(SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')),
       'relations',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','vector_collections') AND c.relkind IN ('m','f','p','S')))""")
    require(all(value == 0 for value in unsupported.values()), 'unsupported-fixture-database-object')
    tables = sql_json(state, side, service, """SELECT coalesce(json_agg(json_build_object('schema',n.nspname,'table',c.relname)
       ORDER BY n.nspname,c.relname),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'""")
    require(len(tables) <= 128, 'table-count-bound')
    total_rows, result, count_queries, row_queries = 0, [], [], []
    for table in tables:
        require(table['schema'] in ['public', 'vector_collections'], 'expected-database-schema')
        identifier = name(table['schema']) + '.' + name(table['table'])
        # Names have passed ASCII identifier validation; literal labels cannot contain SQL quotes.
        label = "'" + table['schema'] + '.' + table['table'] + "'"
        count_queries.append('SELECT ' + label + ' AS relation,count(*) AS rows FROM ' + identifier)
        row_queries.append('SELECT ' + label + ' AS relation,to_jsonb(r)::text AS value FROM ' + identifier + ' r')
    require(tables, 'expected-user-tables')
    counts = sql_json(state, side, service, 'SELECT json_agg(row_to_json(c) ORDER BY relation) FROM (' + ' UNION ALL '.join(count_queries) + ') c')
    for table in tables:
        count = next(value['rows'] for value in counts if value['relation'] == table['schema'] + '.' + table['table'])
        total_rows += count
        result.append({**table, 'rows': count})
    require(total_rows <= 50000, 'row-count-bound')
    copy = 'COPY (SELECT relation,value FROM (' + ' UNION ALL '.join(row_queries) + ') all_rows ORDER BY relation,value) TO STDOUT'
    require(len(copy) <= 65536, 'bounded-proof-query')
    hashed = bounded_stream(database_command(state, side, service, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', copy), maximum=MAX_DUMP, timeout=60)
    schema = bounded_stream(database_command(state, side, service, 'pg_dump', '--schema-only', '--create'), maximum=MAX_SCHEMA, timeout=60, capture=True)
    metadata = sql_json(state, side, service, """SELECT json_build_object('name',d.datname,'owner',pg_get_userbyid(d.datdba),
       'encoding',pg_encoding_to_char(d.encoding),'localeProvider',d.datlocprovider,'collation',d.datcollate,'ctype',d.datctype,
       'locale',d.datlocale,'collationVersion',d.datcollversion,'connectionLimit',d.datconnlimit,'allowConnections',d.datallowconn,
       'tablespace',t.spcname,'acl',(SELECT json_agg(json_build_object('grantor',pg_get_userbyid(a.grantor),
         'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
         'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable)
         FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a))
       FROM pg_database d JOIN pg_tablespace t ON t.oid=d.dattablespace WHERE d.datname=current_database()""")
    extensions = sql_json(state, side, service, "SELECT coalesce(json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname),'[]'::json) FROM pg_extension")
    if service == 'vector':
        selected = {row['name']: row['version'] for row in extensions}
        require(selected.get('vector') == '0.8.7' and selected.get('vectorscale') == '0.9.1', 'pinned-vector-extensions')
        identity = sql_json(state, side, service, 'SELECT to_json(identity::text) FROM vector_collections.vx_identity WHERE singleton')
    else:
        identity = None
    return {'tables': result, 'rows': total_rows, 'bytes': hashed['bytes'], 'rowsSha256': hashed['sha256'],
            'schema': schema_categories(schema['data']), 'database': metadata, 'extensions': extensions,
            'roles': role_manifest(state, side, service), 'vectorIdentity': identity}


def snapshot(state, side, accepted):
    counts = verify_fixture_ids(state, side, accepted)
    databases = {service: database_manifest(state, side, service) for service in ['postgres', 'vector']}
    return {'counts': counts, 'databases': databases, 'sha256': digest(canonical(databases))}


def public_snapshot(value):
    return {'databaseManifestSha256': value['sha256'], 'counts': value['counts'],
            'databases': {key: {'tables': len(row['tables']), 'rows': row['rows'], 'bytes': row['bytes']}
                          for key, row in value['databases'].items()}}
