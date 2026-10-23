"""Pure restore guard tests: filesystem fixtures/mocks only, no Docker/DB/network/provider I/O."""
import copy
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import m7c_restore_common as common
from m7c_restore_archive import normalized_schema, reviewed_role_import
from m7c_restore_proof import schema_categories

spec = importlib.util.spec_from_file_location('restore_main', Path(__file__).with_name('m7c-restore.py'))
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)
RUN = '0123456789ab'


def state_fixture():
    prefix = 'vectorix-m7c-restore-' + RUN
    ports = dict(postgres=47001, vector=47002, redis=47003, rustfs=47004, ollama=47005)
    secret = {key: 'a' * 32 for key in ['postgres', 'indexer', 'runtime', 's3Secret']}
    secret['s3Access'] = 'm7c-' + RUN
    environment = dict.fromkeys(common.BASE_ENVIRONMENT_KEYS, '')
    environment.update(NODE_ENV='production', TZ='UTC', VECTORIX_TIME_ZONE='UTC',
        DATABASE_URL=f'postgresql://postgres:{secret["postgres"]}@127.0.0.1:47001/vectorix_m7c_app_{RUN}_test',
        VECTOR_DATABASE_URL=f'postgresql://vectorix_runtime:{secret["runtime"]}@127.0.0.1:47002/vectorix_m7c_vectors_{RUN}_test',
        VECTOR_DATABASE_PROVISIONING_URL=f'postgresql://vectorix_indexer:{secret["indexer"]}@127.0.0.1:47002/vectorix_m7c_vectors_{RUN}_test',
        VECTOR_DATABASE_SCHEMA='vector_collections', REDIS_URL='redis://127.0.0.1:47003',
        BETTER_AUTH_SECRET='b' * 64, ENCRYPTION_SECRET='c' * 64,
        BETTER_AUTH_URL='http://localhost:3101', API_URL='http://localhost:3101', VECTORIX_WEB_URL='http://localhost:3100',
        TRUSTED_ORIGINS='http://localhost:3100,http://localhost:3006', PASSKEY_RP_ID='localhost',
        PASSKEY_ORIGINS='http://localhost:3100,http://localhost:3006',
        ALLOW_ACCOUNT_CREATION='true', ALLOW_ORGANIZATION_CREATION='true', VECTORIX_WEB_PUSH_ENABLED='false',
        VECTORIX_DEFAULT_S3_ENDPOINT='http://127.0.0.1:47004', VECTORIX_S3_ALLOWED_ENDPOINTS='http://127.0.0.1:47004',
        VECTORIX_DEFAULT_S3_REGION='us-east-1', VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE='true',
        VECTORIX_DEFAULT_S3_BUCKET='m7c-' + RUN + '-platform', VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=secret['s3Access'],
        VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=secret['s3Secret'],
        VECTORIX_DEFAULT_OLLAMA_ENDPOINT='http://127.0.0.1:47005', VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS='http://127.0.0.1:47005')
    resources = {side: {service: {'volume': prefix + '-' + side + '-' + service + '-data',
        'volumeIdentity': ('a' if side == 'source' else 'b') * 64,
        'id': ('c' if side == 'source' else 'd') * 64} for service in common.SERVICES} for side in ['source', 'target']}
    return dict(version=1, runId=RUN, prefix=prefix, phase='source-empty-approved-schema-setup-required',
        applicationDatabase='vectorix_m7c_app_' + RUN + '_test', vectorDatabase='vectorix_m7c_vectors_' + RUN + '_test',
        bootstrapDatabase='vectorix_m7c_bootstrap_' + RUN + '_test', environment=environment, ports=ports,
        images={key: 'sha256:' + 'a' * 64 for key in [*common.SERVICES, 'ollama']},
        modelVolume={'name': 'operator-model-cache', 'identity': 'a' * 64}, infrastructureSecrets=secret,
        buckets=['m7c-' + RUN + '-platform', 'm7c-' + RUN + '-organization'], resources=resources, processes={})


def volume_fixture(state, side='source', service='postgres'):
    return dict(Name=state['resources'][side][service]['volume'], CreatedAt='2026-10-01T00:00:00Z',
        Driver='local', Labels=common.labels(state, side, service), Options=None)


def container_fixture(state, volume, side='source', service='postgres'):
    saved = state['resources'][side][service]
    saved['volumeIdentity'] = common.volume_identity(volume)
    return dict(Id=saved['id'], Name='/' + state['prefix'] + '-' + side + '-' + service,
        Image=state['images'][service], Config={'Labels': common.labels(state, side, service)},
        HostConfig={'Privileged': False, 'NetworkMode': 'bridge', 'PortBindings': {
            str(common.SERVICES[service]['port']) + '/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports'][service])}]}},
        Mounts=[{'Type': 'volume', 'RW': True, 'Name': saved['volume'], 'Destination': common.SERVICES[service]['mount']}],
        State={'Running': True})


def roles_fixture(roles=('postgres',)):
    return ('-- PostgreSQL database cluster dump\n\\restrict FIXEDKEY\nSET default_transaction_read_only = off;\n'
        + ''.join('CREATE ROLE "' + role + '";\nALTER ROLE "' + role + '" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD \'SCRAM-SHA-256$4096:YWJj$YWJj:ZGVm\';\n' for role in roles)
        + '\\unrestrict FIXEDKEY\n').encode()


def reviewed_check_fixture(table, canonical=False):
    """Static DDL-only examples; no live artifact/DB access in the guard suite."""
    fragments = {
        'EmbeddingWorkAttempt': ('EmbeddingWorkAttempt_bounds_check', b'((length(("operationKey")::text) >= 1) AND (length(("operationKey")::text) <= 128))'),
        'OrganizationQuota': ('OrganizationQuota_semantic_limits_check', b'(("semanticUnitsPerDocument" >= 1) AND ("semanticUnitsPerDocument" <= 8192))'),
        'SemanticChunkPlan': ('SemanticChunkPlan_bounds_check', b'((octet_length("lastUnitVector") >= 4) AND (octet_length("lastUnitVector") <= 64000))'),
    }
    constraint, fragment = fragments[table]
    if canonical:
        fragment = fragment[1:-1]
    if table == 'SemanticChunkPlan':
        return (b'-- Name: SemanticChunkPlan SemanticChunkPlan_bounds_check; Type: CHECK CONSTRAINT; Schema: public; Owner: postgres\n'
            b'ALTER TABLE public."SemanticChunkPlan"\n'
            b'    ADD CONSTRAINT "SemanticChunkPlan_bounds_check" CHECK ((("configurationRevision" > 0) AND (("lastUnitVector" IS NULL) OR ('
            + fragment + b' AND ((octet_length("lastUnitVector") % 4) = 0))) AND ("reservedBytes" >= 0)));\n')
    return (b'-- Name: ' + table.encode() + b'; Type: TABLE; Schema: public; Owner: postgres\n'
        b'CREATE TABLE public."' + table.encode() + b'" (\n'
        b'    CONSTRAINT "' + constraint.encode() + b'" CHECK ((' + fragment + b' AND (true)))\n);\n')


class StateTests(unittest.TestCase):
    def test_valid_exact_state_and_reject_binding_mutations(self):
        common.validate_state(state_fixture(), RUN)
        cases = [lambda s: s.update(applicationDatabase='application'),
            lambda s: s['environment'].update(DATABASE_URL='postgresql://postgres:secret@example.test:5432/app_test'),
            lambda s: s['environment'].update(REDIS_URL='redis://127.0.0.1:47003/1'),
            lambda s: s['environment'].update(VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY='wrong'),
            lambda s: s['environment'].update(VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS='http://external.test'),
            lambda s: s['environment'].update(ENCRYPTION_SECRET='invalid'),
            lambda s: s['environment'].update(AWS_ACCESS_KEY_ID='never-admit'),
            lambda s: s['ports'].update(vector=47001),
            lambda s: s['buckets'].reverse(),
            lambda s: s['resources']['target']['postgres'].update(volume=s['resources']['source']['postgres']['volume'])]
        for mutate in cases:
            with self.subTest(mutate=cases.index(mutate)):
                state = state_fixture(); mutate(state)
                with self.assertRaises(common.GuardError): common.validate_state(state, RUN)

    def test_exact_container_and_volume_ownership(self):
        state = state_fixture(); volume = volume_fixture(state); container = container_fixture(state, volume)
        def inspect(name, kind='container'): return volume if kind == 'volume' else container
        with patch.object(common, 'metadata', side_effect=inspect): common.owned_container(state, 'source', 'postgres', running=True)
        cases = [lambda c, v: c.update(Id='e' * 64), lambda c, v: c['Config']['Labels'].update({'vectorix.restore-test.id': 'foreign'}),
            lambda c, v: c['HostConfig']['PortBindings']['5432/tcp'][0].update(HostIp='0.0.0.0'),
            lambda c, v: c['Mounts'][0].update(Name='foreign'), lambda c, v: c['Mounts'][0].update(Type='bind'),
            lambda c, v: v.update(CreatedAt='replacement-volume'), lambda c, v: v.update(Options={'device': '/user-data'})]
        for mutate in cases:
            altered_c, altered_v = copy.deepcopy(container), copy.deepcopy(volume); mutate(altered_c, altered_v)
            with patch.object(common, 'metadata', side_effect=lambda name, kind='container': altered_v if kind == 'volume' else altered_c):
                with self.assertRaises(common.GuardError): common.owned_container(state, 'source', 'postgres')

    def test_zombie_process_is_not_signaled_and_foreign_live_process_rejected(self):
        fields = ['Z'] + ['0'] * 20
        with patch.object(Path, 'read_text', return_value='123 (node name) ' + ' '.join(fields)), patch.object(Path, 'read_bytes', side_effect=AssertionError('must not read zombie environ')):
            self.assertIsNone(common.process_identity(123))
        saved = dict(pid=123, bootId='boot', startTicks='1', entry=str(common.ROOT / 'apps/api/dist/index.mjs'), runId=RUN, side='source')
        with patch.object(Path, 'read_text', return_value='boot'), patch.object(common, 'process_identity', return_value=None):
            self.assertFalse(common.process_alive(saved))
        with patch.object(Path, 'read_text', return_value='boot'), patch.object(common, 'process_identity', return_value={
            'startTicks': '1', 'command': [str(common.ROOT / 'apps/api/dist/index.mjs').encode()], 'cwd': common.ROOT,
            'markers': {'VECTORIX_RESTORE_RUN': 'foreign', 'VECTORIX_RESTORE_SIDE': 'source'}}):
            with self.assertRaises(common.GuardError): common.process_alive(saved)


class FileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=common.CACHE, prefix='m7c-static-test-')
        self.directory = Path(self.temp.name); self.directory.chmod(0o700)
    def tearDown(self): self.temp.cleanup()

    def test_private_roundtrip_caps_modes_and_symlinks(self):
        file = self.directory / 'state.json'; common.save_json(file, {'safe': True}, exclusive=True)
        self.assertEqual(common.read_json(file), {'safe': True})
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(common.GuardError): common.read_private_bytes(file, 1)
        file.chmod(0o644)
        with self.assertRaises(common.GuardError): common.read_json(file)
        file.chmod(0o600)
        alias = self.directory / 'alias'; alias.symlink_to(file)
        with self.assertRaises(OSError): common.read_json(alias)
        directory_alias = self.directory / 'parent-alias'; directory_alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(OSError): common.read_json(directory_alias / 'state.json')
        common.save_json(file, {'updated': True}); self.assertEqual(common.read_json(file), {'updated': True})

    def test_lock_is_exclusive_and_released_on_error(self):
        with patch.object(common, 'CACHE', self.directory):
            with common.state_lock():
                with self.assertRaises(BlockingIOError):
                    with common.state_lock(): pass
            try:
                with common.state_lock(): raise RuntimeError('controlled')
            except RuntimeError: pass
            with common.state_lock(): pass


class ArchiveTests(unittest.TestCase):
    def test_schema_only_random_restrict_key_normalizes(self):
        first = b'\\restrict AAA\nCREATE TABLE owned(id int);\n\\unrestrict AAA\n'
        second = first.replace(b'AAA', b'BBB')
        self.assertEqual(normalized_schema(first), normalized_schema(second))
        self.assertNotEqual(schema_categories(first)['sha256'], schema_categories(first.replace(b'int', b'bigint'))['sha256'])
        self.assertNotEqual(schema_categories(first)['sha256'], schema_categories(first + b'GRANT SELECT ON owned TO PUBLIC;\n')['sha256'])
        with self.assertRaises(common.GuardError): normalized_schema(first.replace(b'unrestrict AAA', b'unrestrict BBB'))
        reconnect = first + b'\\connect owned_test\n' + second
        self.assertEqual(normalized_schema(reconnect), normalized_schema(first) + b'\\connect owned_test\n' + normalized_schema(second))
        for invalid in [first + b'\\unrestrict AAA\n', b'\\restrict AAA\n' + second, first + b'\\restrict AAA\n', first * 9]:
            with self.assertRaises(common.GuardError): normalized_schema(invalid)

    def test_schema_three_reviewed_and_groups_are_canonical_and_idempotent(self):
        for table in ['EmbeddingWorkAttempt','OrganizationQuota','SemanticChunkPlan']:
            with self.subTest(table=table):
                source=reviewed_check_fixture(table)
                canonical=reviewed_check_fixture(table,True)
                self.assertNotEqual(source,canonical)
                self.assertEqual(len(source)-len(canonical),2)
                self.assertEqual(normalized_schema(source),canonical)
                self.assertEqual(normalized_schema(canonical),canonical)
                self.assertEqual(normalized_schema(normalized_schema(source)),canonical)

    def test_schema_changed_bounds_boolean_and_arithmetic_are_not_masked(self):
        cases=[
            ('EmbeddingWorkAttempt', b'<= 128',b'<= 129'),
            ('OrganizationQuota', b'<= 8192',b'<= 8193'),
            ('SemanticChunkPlan', b'<= 64000',b'<= 64001'),
            ('EmbeddingWorkAttempt', b'>= 1) AND (length',b'>= 1) OR (length'),
            ('OrganizationQuota', b'>= 1) AND ("semantic',b'>= 1) OR ("semantic'),
            ('SemanticChunkPlan', b'IS NULL) OR (',b'IS NULL) AND ('),
            ('OrganizationQuota', b'CHECK ((((',b'CHECK ((NOT (('),
            ('SemanticChunkPlan', b'IS NULL) OR ((',b'IS NULL) OR (NOT ('),
            ('SemanticChunkPlan', b'% 4',b'% 8'),
        ]
        for table,before,after in cases:
            with self.subTest(table=table,mutation=after):
                original=reviewed_check_fixture(table)
                self.assertIn(before,original)
                altered=original.replace(before,after,1)
                self.assertEqual(normalized_schema(altered),altered)
                self.assertNotEqual(schema_categories(original)['sha256'],schema_categories(altered)['sha256'])

    def test_schema_unknown_constraint_table_schema_and_missing_header_are_preserved(self):
        original=reviewed_check_fixture('OrganizationQuota')
        cases=[original.replace(b'OrganizationQuota_semantic_limits_check',b'Unknown_constraint'),
            original.replace(b'OrganizationQuota',b'UnknownTable'),
            original.replace(b'Schema: public;',b'Schema: other;').replace(b'CREATE TABLE public.',b'CREATE TABLE other.'),
            original.split(b'\n',1)[1],
            original.replace(b'CREATE TABLE public.',b'-- CREATE TABLE public.')]
        for altered in cases:
            self.assertEqual(normalized_schema(altered),altered)

    def test_schema_function_body_and_nested_comments_never_normalize_fake_ddl(self):
        source=reviewed_check_fixture('OrganizationQuota')
        canonical=reviewed_check_fixture('OrganizationQuota',True)
        wrappers=[
            (b'-- Name: owned; Type: FUNCTION; Schema: public; Owner: postgres\nCREATE FUNCTION public.owned() RETURNS void LANGUAGE plpgsql AS $body$\n',b'\n$body$;\n'),
            (b'/* outer comment\n/* nested */\n',b'*/\n'),
            (b"SELECT '",b"';\n"),
        ]
        for prefix,suffix in wrappers:
            with self.subTest(prefix=prefix):
                before=prefix+source+suffix;after=prefix+canonical+suffix
                self.assertEqual(normalized_schema(before),before)
                self.assertEqual(normalized_schema(after),after)
                self.assertNotEqual(schema_categories(before)['sha256'],schema_categories(after)['sha256'])
        body=(b'CREATE FUNCTION public.owned() RETURNS text LANGUAGE sql AS $body$\n'
              b"\\restrict LITERAL\nSELECT 'literal';\n\\unrestrict LITERAL\n$body$;\n")
        self.assertEqual(normalized_schema(body),body)

    def test_schema_known_text_inside_literal_check_is_not_rewritten(self):
        raw=reviewed_check_fixture('SemanticChunkPlan')
        prefix,check=raw.rsplit(b'    ADD CONSTRAINT',1)
        fragment=check[check.index(b' AND (("lastUnitVector"'):check.index(b' AND ("reservedBytes"')]
        altered=(prefix+b'    ADD CONSTRAINT "SemanticChunkPlan_bounds_check" CHECK ('+bytes([39])+fragment+b"' IS NOT NULL);\n")
        self.assertEqual(normalized_schema(altered),altered)

    def test_schema_duplicate_reviewed_check_context_fails_closed(self):
        raw=reviewed_check_fixture('OrganizationQuota')
        with self.assertRaisesRegex(common.GuardError,'^schema-known-check-duplicate$'):
            normalized_schema(raw+raw)

    def test_role_import_preserves_hashes_and_removes_only_reviewed_creates(self):
        raw = roles_fixture(('postgres', 'vectorix_indexer', 'vectorix_runtime'))
        imported = reviewed_role_import(raw, ['postgres', 'vectorix_indexer', 'vectorix_runtime'])
        self.assertNotIn(b'CREATE ROLE', imported); self.assertEqual(imported.count(b'ALTER ROLE'), 3)
        self.assertIn(b'SCRAM-SHA-256$4096:YWJj$YWJj:ZGVm', imported)

    def test_role_import_rejects_extra_sql_meta_commands_and_wrong_roles(self):
        raw = roles_fixture()
        malformed = [raw.replace(b"ZGVm';", b"ZGVm'; SELECT 1;"), raw + b'\\copy secret TO PROGRAM \'x\'\n',
            raw + b'\\gexec\n', raw + b'\\connect application\n', raw + b'CREATE ROLE "foreign";\n',
            raw.replace(b'PASSWORD', b'VALID UNTIL \'infinity\' PASSWORD'), raw.replace(b'\\unrestrict FIXEDKEY', b'\\unrestrict WRONG')]
        for value in malformed:
            with self.assertRaises(common.GuardError): reviewed_role_import(value, ['postgres'])


class ProtocolTests(unittest.TestCase):
    def test_object_child_error_protocol_never_turns_nonzero_exit_into_success(self):
        state = state_fixture()
        def response(payload, exit_code):
            return {'data': common.canonical(payload), 'exitCode': exit_code}
        with patch.object(main, 'owned_container'), patch.object(main, 'bounded_stream', return_value=response({'completed': False, 'diagnostic': 'catalog-object-content-type'}, 1)):
            with self.assertRaisesRegex(common.GuardError, '^object-child-catalog-object-content-type$'):
                main.object_step(state, Path('unused/state.json'), 'export')
        with patch.object(main, 'owned_container'), patch.object(main, 'bounded_stream', return_value=response({'completed': False, 'diagnostic': 'unsafe error with a secret'}, 1)):
            with self.assertRaisesRegex(common.GuardError, '^object-child-sanitized-object-step-failure$'):
                main.object_step(state, Path('unused/state.json'), 'export')
        with patch.object(main, 'owned_container'), patch.object(main, 'bounded_stream', return_value=response({'formatVersion': 1}, 1)):
            with self.assertRaisesRegex(common.GuardError, '^object-child-success-protocol$'):
                main.object_step(state, Path('unused/state.json'), 'export')
        with self.assertRaisesRegex(common.GuardError, '^structured-child-exit-policy$'):
            common.bounded_stream(['not-executed'], destination=Path('unused'), allowed_exit_codes=(0, 1))

    def test_incomplete_capture_quarantine_preserves_owned_bytes_and_allows_fresh_capture(self):
        state = state_fixture(); state['phase'] = 'capture-in-progress'; state['resources']['target'] = {}
        with tempfile.TemporaryDirectory(dir=common.CACHE, prefix='m7c-static-quarantine-') as directory:
            path = Path(directory) / 'state.json'; path.parent.chmod(0o700)
            bundle = path.parent / 'bundle'; bundle.mkdir(mode=0o700)
            common.save_json(bundle / 'runtime.json', {'synthetic': True}, exclusive=True)
            with patch.object(main, 'no_apps'), patch.object(main, 'owned_container'), patch.object(main, 'save'):
                result = main.quarantine_capture(path, state)
            self.assertFalse(result['successfulBackup']); self.assertFalse(result['sourceModified'])
            self.assertFalse(bundle.exists()); self.assertEqual(len(state['quarantinedCaptures']), 1)
            preserved = path.parent / state['quarantinedCaptures'][0]['directory'] / 'runtime.json'
            self.assertEqual(common.read_json(preserved), {'synthetic': True})

    def test_quarantine_refuses_complete_or_unknown_artifacts_without_moving_them(self):
        state = state_fixture(); state['phase'] = 'capture-in-progress'; state['resources']['target'] = {}
        with tempfile.TemporaryDirectory(dir=common.CACHE, prefix='m7c-static-quarantine-') as directory:
            path = Path(directory) / 'state.json'; path.parent.chmod(0o700)
            bundle = path.parent / 'bundle'; bundle.mkdir(mode=0o700)
            with patch.object(main, 'no_apps'), patch.object(main, 'owned_container'), patch.object(main, 'save'):
                common.save_json(bundle / 'manifest.json', {'complete': True}, exclusive=True)
                with self.assertRaises(common.GuardError): main.quarantine_capture(path, state)
                (bundle / 'manifest.json').unlink()
                common.save_json(bundle / 'unexpected.json', {'safe': True}, exclusive=True)
                with self.assertRaises(common.GuardError): main.quarantine_capture(path, state)
                self.assertTrue((bundle / 'unexpected.json').exists())
                self.assertNotIn('quarantinedCaptures', state)

    def test_read_only_scalar_json_requires_sql_json_encoding(self):
        state = state_fixture()
        with patch.object(common, 'database_command', return_value=['not-executed']), patch.object(common, 'run', return_value=b'"01234567-89ab-cdef-0123-456789abcdef"'):
            self.assertEqual(common.sql_json(state, 'source', 'vector', 'SELECT to_json(identity::text)'), '01234567-89ab-cdef-0123-456789abcdef')
        with patch.object(common, 'database_command', return_value=['not-executed']), patch.object(common, 'run', return_value=b'01234567-89ab-cdef-0123-456789abcdef'):
            with self.assertRaisesRegex(common.GuardError, '^read-only-json-response-shape$'):
                common.sql_json(state, 'source', 'vector', 'SELECT identity::text')

    def test_pre_export_capture_can_resume_but_partial_bundle_is_not_overwritten(self):
        state = state_fixture(); state['phase'] = 'capture-in-progress'
        with tempfile.TemporaryDirectory(dir=common.CACHE, prefix='m7c-static-capture-') as directory:
            path = Path(directory) / 'state.json'
            with patch.object(main, 'stop_apps', side_effect=RuntimeError('accepted-pre-export-resume')):
                with self.assertRaisesRegex(RuntimeError, 'accepted-pre-export-resume'): main.capture(path, state)
            (path.parent / 'bundle').mkdir()
            with patch.object(main, 'stop_apps') as stop:
                with self.assertRaises(common.GuardError): main.capture(path, state)
                stop.assert_not_called()

    def test_optional_draft_gate_and_low_disk_refuse_before_execution(self):
        with patch.object(main, 'STATIC_DRAFT_ONLY', True):
            with self.assertRaises(common.GuardError): main.main()
        with patch.object(main.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 4 * 1024 ** 3 - 1})()):
            with self.assertRaises(common.GuardError): main.free_space()

    def test_explicit_source_deploy_pins_chain_config_and_clean_environment(self):
        state = state_fixture(); state['resources']['target'] = {}
        state['migrations'] = {'approved': 'a' * 64}
        state['lockfileSha256'] = common.digest((common.ROOT / 'pnpm-lock.yaml').read_bytes())
        state['prismaConfigSha256'] = common.digest((common.ROOT / 'packages/db/prisma.config.ts').read_bytes())
        calls = []
        with patch.object(main, 'no_apps'), patch.object(main, 'migration_manifest', return_value=state['migrations']), \
            patch.object(main, 'owned_container'), patch.object(main, 'run', side_effect=lambda args, **kwargs: calls.append((args, kwargs)) or b''):
            result = main.deploy_approved_source_schema(Path('unused'), state)
        self.assertFalse(result['schemaGenerated']); self.assertFalse(result['targetModified'])
        self.assertEqual(len(calls), 1)
        args, options = calls[0]
        self.assertEqual(args[2:4], ['migrate', 'deploy'])
        self.assertEqual(args[-2:], ['--config', str(common.ROOT / 'packages/db/prisma.config.ts')])
        self.assertEqual(options['environment']['DATABASE_URL'], state['environment']['DATABASE_URL'])
        self.assertNotIn('HOME', options['environment']); self.assertNotIn('ENCRYPTION_SECRET', options['environment'])
        self.assertEqual(options['timeout'], 60)
        state['phase'] = 'restored-not-yet-verified'
        with self.assertRaises(common.GuardError): main.deploy_approved_source_schema(Path('unused'), state)

    def test_partial_target_cleanup_recreation_has_guarded_transition(self):
        state = state_fixture(); state['phase'] = 'cleaned-target'; state['resources']['target'] = {}
        with patch.object(main, 'free_space'), patch.object(main, 'verify_bundle'), patch.object(main, 'no_apps'), \
            patch.object(main, 'owned_container'), patch.object(main, 'free_port'), patch.object(main, 'save'), \
            patch.object(main, 'create_service', side_effect=lambda path, s, side, service: s['resources'][side].update({service: {'volumeIdentity': 'b'*64}})):
            self.assertEqual(main.create_target(Path('unused'), state)['phase'], 'empty-target-infrastructure')
        state['phase'] = 'cleaned-target'; state['resources']['target'] = {}; state['resources']['source'] = {}
        with patch.object(main, 'free_space'):
            with self.assertRaises(common.GuardError): main.create_target(Path('unused'), state)

    def test_missing_model_cleanup_refuses_unknown_name_never_removes_volume(self):
        state = state_fixture(); state['resources'] = {'source': {}, 'target': {}}; state['modelContainer'] = None
        commands = []
        with patch.object(main, 'no_apps'), patch.object(main, 'save'), patch.object(main, 'run', side_effect=lambda args: commands.append(args) or b''):
            result = main.cleanup_model(Path('unused'), state)
        self.assertEqual(result['preservedModelVolume'], 'operator-model-cache')
        self.assertEqual(len(commands), 1); self.assertEqual(commands[0][1:3], ['container', 'ls'])
        with patch.object(main, 'no_apps'), patch.object(main, 'run', return_value=b'unknown'):
            with self.assertRaises(common.GuardError): main.cleanup_model(Path('unused'), state)


if __name__ == '__main__': unittest.main(verbosity=2)
