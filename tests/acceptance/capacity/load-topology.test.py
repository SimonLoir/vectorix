"""Offline synthetic/mocked lifecycle tests. Never calls Docker, HTTP, DB, provider or real processes."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import load_topology_policy as policy
spec = importlib.util.spec_from_file_location('load_topology', HERE / 'load-topology.py')
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)
RUN = 'abcdef012345'


def fixture(experiment_id="DEFAULT_V1"):
    selected = policy.get_load_policy(experiment_id)
    ports = dict(postgres=45101, vector=45102, redis=45103, rustfs=45104, ollama=45105, api=45106, web=45107, admin=45108)
    secret = {key: 'a' * 32 for key in ['postgres', 'indexer', 'runtime', 's3Secret']}
    secret['s3Access'] = 'm7c-load-' + RUN
    api, web = 'http://127.0.0.1:45106', 'http://127.0.0.1:45107'
    environment = dict.fromkeys(policy.ENVIRONMENT_KEYS, '')
    environment.update(NODE_ENV='production', TZ='UTC', VECTORIX_TIME_ZONE='UTC',
        DATABASE_URL=f'postgresql://postgres:{secret["postgres"]}@127.0.0.1:45101/vectorix_m7c_load_app_{RUN}_test',
        VECTOR_DATABASE_URL=f'postgresql://vectorix_runtime:{secret["runtime"]}@127.0.0.1:45102/vectorix_m7c_load_vectors_{RUN}_test',
        VECTOR_DATABASE_PROVISIONING_URL=f'postgresql://vectorix_indexer:{secret["indexer"]}@127.0.0.1:45102/vectorix_m7c_load_vectors_{RUN}_test',
        VECTOR_DATABASE_SCHEMA='vector_collections', REDIS_URL='redis://127.0.0.1:45103',
        BETTER_AUTH_SECRET='b' * 64, ENCRYPTION_SECRET='c' * 64,
        BETTER_AUTH_URL=api, API_URL=api, VECTORIX_WEB_URL=web, TRUSTED_ORIGINS=web,
        ALLOW_ACCOUNT_CREATION='true', ALLOW_ORGANIZATION_CREATION='true', VECTORIX_WEB_PUSH_ENABLED='false',
        VECTORIX_DEFAULT_S3_ENDPOINT='http://127.0.0.1:45104', VECTORIX_DEFAULT_S3_REGION='us-east-1',
        VECTORIX_DEFAULT_S3_BUCKET='m7c-load-' + RUN, VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE='true',
        VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=secret['s3Access'], VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=secret['s3Secret'],
        VECTORIX_S3_ALLOWED_ENDPOINTS='http://127.0.0.1:45104', VECTORIX_DEFAULT_OLLAMA_ENDPOINT='http://127.0.0.1:45105',
        VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS='http://127.0.0.1:45105', PASSKEY_RP_ID='127.0.0.1',
        PASSKEY_RP_NAME='Vectorix isolated load acceptance', PASSKEY_ORIGINS=web)
    state = {'schemaVersion': 1, 'namespace': policy.NAMESPACE, 'runId': RUN, 'prefix': policy.NAMESPACE + '-' + RUN,
        'phase': 'PREPARING', 'ports': ports, 'images': {name: 'sha256:' + 'd' * 64 for name in policy.SERVICES},
        'resourceLimits': copy.deepcopy(policy.DEFAULT_LIMITS), 'resources': {}, 'processes': {}, 'dashboardProcesses': {},
        'loadProcess': None, 'infrastructureSecrets': secret, 'commit': 'e' * 40, 'lockfileSha256': 'f' * 64,
        'prismaConfigSha256': '1' * 64, 'migrations': {'20261021000000_initial': '2' * 64},
        'acceptanceSources': {'load-topology.py': '3' * 64}, 'referenceCorpusDigest': '4' * 64,
        'corpusFiles': {'load-v1/full-preflight.json': '8' * 64},
        'loadPolicy': copy.deepcopy(policy.LOAD_POLICY), 'workflowHistory': [],
        'modelVolume': {'name': 'operator-model-volume', 'identity': '5' * 64}, 'builds': {},
        'applicationDatabase': 'vectorix_m7c_load_app_' + RUN + '_test',
        'vectorDatabase': 'vectorix_m7c_load_vectors_' + RUN + '_test', 'apiOrigin': api, 'webOrigin': web,
        'environment': environment}
    for service in ['api', 'workers', 'web']:
        entry = policy.ROOT / ('apps/' + service + '/dist/index.mjs' if service != 'web'
            else 'apps/web/.next/standalone/apps/web/server.js')
        state['builds'][service] = {'entry': str(entry), 'entrySha256': '6' * 64, 'treeSha256': '7' * 64, 'treeFiles': 1}
    state['experimentPolicyId'] = selected['id']
    state['experimentPolicySha256'] = policy.policy_sha256(selected)
    if experiment_id == 'LIGHT_V1':
        old_ns,old_db,old_email=policy.NAMESPACE,'vectorix_m7c_load','m7c-load'
        state=json.loads(json.dumps(state).replace(old_ns,selected['namespace']).replace(old_db,selected['databasePrefix']).replace(old_email,selected['emailPrefix']))
        state['loadPolicy']=selected['loadPolicy']
        state['corpusFiles']={'light-v1/full-preflight.json':'8'*64}
    return state


def process_record(state, service='api'):
    entry = state['builds'][service]['entry'] if service != 'load' else str(HERE / 'load-import-runtime.mjs')
    return {'pid': 987654, 'startTicks': '123456', 'bootId': '12345678-1234-1234-1234-123456789abc',
        'entry': entry, 'entrySha256': '6' * 64, 'cwd': str(Path(entry).parent) if service != 'load' else str(policy.ROOT),
        'service': service}


def load_fixture(state):
    users = {role: {'userId': role + '-user', 'memberId': role + '-member',
        'organizationId': 'org-b' if role == 'foreign' else 'org-a',
        'email': policy.load_policy_for_state(state)['emailPrefix'] + '-' + role + '-' + RUN + '@example.test', 'password': role + '-' + 'x' * 32}
        for role in ['owner', 'reader', 'foreign']}
    return {'schemaVersion': 1, 'namespace': state['namespace'], 'runId': RUN,
        'experimentPolicyId':state['experimentPolicyId'],'experimentPolicySha256':state['experimentPolicySha256'],
        'organizationIds': ['org-a', 'org-b'], 'users': users}


def pilot_report():
    return {'schemaVersion': 1, 'namespace': policy.NAMESPACE, 'runId': RUN, 'workflow': 'pilot',
        'experimentPolicyId':'DEFAULT_V1','policySha256':policy.policy_sha256(policy.get_load_policy('DEFAULT_V1')),
        'status': 'COMPLETE', 'acceptance': 'PILOT_PREPARED', 'evidenceKind': 'LIVE_NATIVE_ISOLATED',
        'corpusSha256': policy.LOAD_POLICY['pilotCorpusSha256'], 'familySha256': policy.LOAD_POLICY['familySha256'],
        'collections':{'pilot':{'collectionRole':'pilotA','policySha256':policy.policy_sha256(policy.get_load_policy('DEFAULT_V1'))}},
        'timing': {'pilotIndexMs': 140000}, 'pilotObservation': {'physicalChildren': 2000,
            'validatedNativeVectors': 2000, 'peakMemoryBytes': 1024 ** 3, 'minimumFreeBytes': 5 * 1024 ** 3,
            'modelWarmState': 'UNKNOWN', 'retries': 0, 'errors': 0, 'providerInputTokens': None,
            'resourcePolicySha256': main.load_resource_policy_hash(fixture())}}


def full_report():
    report = pilot_report()
    report.update(workflow='full', acceptance='FULL_INDEX_PREPARED',
        corpusSha256=policy.LOAD_POLICY['fullCorpusSha256'], timing={'fullIndexMs': 7000000},
        documents={'loadA': [{'documentId': 'document-' + str(index)} for index in range(200)]},
        collections={'primary': {'collectionId': 'full-collection', 'generationId': 'full-generation',
            'activeChildren': 100000, 'parents': 25000,'collectionRole':'primaryA','policySha256':policy.policy_sha256(policy.get_load_policy('DEFAULT_V1'))},
            'pilot': {'collectionId': 'pilot-collection', 'generationId': 'pilot-generation',
                'activeChildren': 2000, 'parents': 500,'collectionRole':'pilotA','policySha256':policy.policy_sha256(policy.get_load_policy('DEFAULT_V1'))}})
    report['fullObservation'] = {**report.pop('pilotObservation'), 'physicalChildren': 100000,
        'parents': 25000, 'validatedNativeVectors': 100000, 'manifestSha256': 'a' * 64}
    return report


def volume(state, service):
    return {'Name': state['modelVolume']['name'] if service == 'ollama' else state['prefix'] + '-' + service + '-data',
        'CreatedAt': '2026-01-01T00:00:00Z', 'Driver': 'local', 'Options': None,
        'Labels': {'operator': 'preserve'} if service == 'ollama' else policy.labels(RUN, service, state['experimentPolicyId'])}


def add_resource(state, service, *, identifier='a' * 64):
    value = volume(state, service)
    if service == 'ollama': state['modelVolume']['identity'] = policy.volume_identity(value)
    state['resources'][service] = {'name': state['prefix'] + '-' + service, 'id': identifier,
        'imageId': state['images'][service], 'volume': value['Name'], 'volumeIdentity': policy.volume_identity(value)}
    return value


def container(state, service, running=True):
    saved = state['resources'][service]
    return {'Id': saved['id'], 'Name': '/' + saved['name'], 'Image': state['images'][service],
        'State': {'Running': running}, 'Config': {'Labels': policy.labels(RUN, service, state['experimentPolicyId'])},
        'HostConfig': {'NetworkMode': 'bridge', 'Privileged': False, 'VolumesFrom': None, 'Links': None,
            'NanoCpus': policy.nano_cpus(state['resourceLimits'][service]['cpus']),
            'Memory': state['resourceLimits'][service]['memoryBytes'],
            'PortBindings': {str(policy.SERVICES[service][0]) + '/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports'][service])}]}},
        'Mounts': [{'Type': 'volume', 'Name': saved['volume'], 'Destination': policy.SERVICES[service][1], 'RW': service != 'ollama'}]}


class PolicyTests(unittest.TestCase):
    def test_lifecycle_output_never_claims_draft_or_native_acceptance(self):
        state = fixture()
        for enabled in [False, True]:
            with patch.object(main, 'DRAFT_ONLY', not enabled):
                value = main.lifecycle_status(state)
            self.assertEqual(value, {'runId': RUN, 'phase': 'PREPARING', 'resourceCount': 0,
                'executionEnabled': enabled, 'acceptanceSource': 'PRIVATE_WORKFLOW_REPORTS'})

    def test_explicit_runtime_helpers_are_bounded_complete_regular_owned_files(self):
        with tempfile.TemporaryDirectory(dir=policy.ROOT / 'node_modules', prefix='load-helper-inventory-') as owned:
            directory = Path(owned)
            for name in ['one.mjs', 'two.py']:
                (directory / name).write_bytes(b'// synthetic local helper\n')
            with patch.object(main, 'HERE', directory), patch.object(main, 'PINNED_HELPERS', ['one.mjs', 'two.py']):
                result = main.helper_manifest()
                self.assertEqual(set(result), {'one.mjs', 'two.py', 'shared-restore-common.py'})
                self.assertTrue(all(policy.valid_hash(value) for value in result.values()))
            for names in [[], ['one.mjs', 'one.mjs'], ['../outside.mjs'], ['shared-restore-common.py'],
                    ['one.mjs'] * 64, ['missing.mjs']]:
                with patch.object(main, 'HERE', directory), patch.object(main, 'PINNED_HELPERS', names):
                    with self.assertRaises(policy.GuardError): main.helper_manifest()
            (directory / 'link.mjs').symlink_to(directory / 'one.mjs')
            with patch.object(main, 'HERE', directory), patch.object(main, 'PINNED_HELPERS', ['link.mjs']):
                with self.assertRaisesRegex(policy.GuardError, 'load-helper-file-safety'):
                    main.helper_manifest()
            (directory / 'large.mjs').write_bytes(b'x' * (2 * 1024 ** 2 + 1))
            with patch.object(main, 'HERE', directory), patch.object(main, 'PINNED_HELPERS', ['large.mjs']):
                with self.assertRaisesRegex(policy.GuardError, 'load-helper-file-safety'):
                    main.helper_manifest()

    def test_resource_hash_matches_independently_computed_js_canonical_vector(self):
        state = {'commit': 'a' * 40, 'images': {'z': 'sha256:' + 'b' * 64, 'a': 'sha256:' + 'c' * 64},
            'resourceLimits': {'ollama': {'cpus': '4', 'memoryBytes': 6442450944}},
            'loadPolicy': {'profile': {'parentChild': True, 'targetTokens': 512}, 'version': 'native-default-load-v1'}}
        self.assertEqual(main.load_resource_policy_hash(state),
            '83ae7837c64069e2ce82e05bfc10e310c702d052a893715bc8ec72b817ee212c')

    def test_initial_state_binds_actual_unchanged_corpus_schema_and_hashes(self):
        source = fixture()
        with patch.object(main, 'helper_manifest', return_value=source['acceptanceSources']), \
                patch.object(main, 'migration_manifest', return_value=source['migrations']):
            state = main.initial_state(RUN, source['ports'], source['images'], source['modelVolume'],
                source['builds'], source['commit'])
        manifest = json.loads((policy.ROOT / 'tests/acceptance/quality/reference-v1/manifest.json').read_bytes())
        proof = json.loads((policy.ROOT / 'tests/acceptance/capacity/load-v1/pure-preparation-proof.json').read_bytes())
        self.assertEqual(state['referenceCorpusDigest'], manifest['corpusDigest'])
        self.assertEqual(len(state['corpusFiles']), 56)
        for field in ['familySha256', 'pilotCorpusSha256', 'fullCorpusSha256']:
            self.assertEqual(state['loadPolicy'][field], proof[field])
        self.assertEqual(state['workflowHistory'], [])

    def test_load_scope_and_default_profile_cannot_adopt_quality_or_change_limits(self):
        for mutate in [lambda s: s.update(namespace='vectorix-m7c-quality'),
                lambda s: s.update(applicationDatabase='vectorix_m7c_quality_app_' + RUN + '_test'),
                lambda s: s['loadPolicy'].update(maximumDocuments=241),
                lambda s: s['loadPolicy']['profile'].update(targetTokens=128),
                lambda s: s['loadPolicy']['resourceSampling'].update(maximumSamples=20001),
                lambda s: s['resourceLimits']['ollama'].update(cpus='8'),
                lambda s: s.update(workflowHistory=['full'])]:
            state = fixture(); mutate(state)
            with self.assertRaises(policy.GuardError): policy.validate_state(state, RUN)
        self.assertEqual(policy.LOAD_POLICY['primaryDocuments'] + policy.LOAD_POLICY['referenceDocuments'] +
            policy.LOAD_POLICY['concurrentDocuments'], 236)
        self.assertEqual(policy.LOAD_POLICY['maximumDocuments'], 240)
        self.assertEqual(policy.LOAD_POLICY['maximumCollections'], 20)

    def test_valid_partial_state_and_complete_requirement(self):
        value = fixture(); policy.validate_state(value, RUN)
        with self.assertRaises(policy.GuardError): policy.validate_state(value, RUN, complete=True)
        for index, service in enumerate(policy.SERVICES): add_resource(value, service, identifier=str(index + 1) * 64)
        policy.validate_state(value, RUN, complete=True)

    def test_no_restore_alias_or_origin_provider_environment_escapes(self):
        mutations = [lambda s: s.update(namespace='vectorix-m7c-restore'),
            lambda s: s.update(applicationDatabase='production'),
            lambda s: s.update(webOrigin='http://localhost:45107'),
            lambda s: s['environment'].update(TRUSTED_ORIGINS='http://evil.example'),
            lambda s: s['environment'].update(DATABASE_URL='postgresql://postgres:secret@elsewhere/app_test'),
            lambda s: s['environment'].update(VECTORIX_DEFAULT_OPENAI_API_KEY='foreign-secret'),
            lambda s: s['environment'].update(HTTP_PROXY='http://proxy.example'),
            lambda s: s['ports'].update(api=s['ports']['postgres']),
            lambda s: s['modelVolume'].update(name=s['prefix']+'-postgres-data'),
            lambda s: s['images'].update(ollama='ollama:latest')]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                value=fixture();mutate(value)
                with self.assertRaises(policy.GuardError): policy.validate_state(value,RUN)

    def test_cpu_limits_are_exact_and_reject_invalid_decimal_shapes(self):
        self.assertEqual(policy.nano_cpus('0.5'),500000000)
        self.assertEqual(policy.nano_cpus('4'),4000000000)
        for value in ['0','0.01','0.1.2','65','NaN','1e2',1]:
            with self.assertRaises(policy.GuardError): policy.nano_cpus(value)

    def test_immutable_container_mount_limits_and_volume_identity(self):
        state=fixture();saved_volume=add_resource(state,'postgres');value=container(state,'postgres')
        policy.validate_volume(state,'postgres',saved_volume);policy.validate_container(state,'postgres',value,running=True)
        mutations=[lambda v:v.update(Id='b'*64),lambda v:v.update(Image='sha256:'+'c'*64),
            lambda v:v['Config']['Labels'].clear(),lambda v:v['HostConfig'].update(NetworkMode='host'),
            lambda v:v['HostConfig'].update(Privileged=True),lambda v:v['HostConfig'].update(Memory=0),
            lambda v:v['HostConfig']['PortBindings']['5432/tcp'][0].update(HostIp='0.0.0.0'),
            lambda v:v['Mounts'][0].update(Type='bind')]
        for mutate in mutations:
            altered=copy.deepcopy(value);mutate(altered)
            with self.assertRaises(policy.GuardError):policy.validate_container(state,'postgres',altered)
        saved_volume['CreatedAt']='2026-02-01T00:00:00Z'
        with self.assertRaises(policy.GuardError):policy.validate_volume(state,'postgres',saved_volume)

    def test_model_mount_is_readonly_and_keeps_operator_labels(self):
        state=fixture();saved=add_resource(state,'ollama');value=container(state,'ollama')
        policy.validate_volume(state,'ollama',saved);policy.validate_container(state,'ollama',value)
        value['Mounts'][0]['RW']=True
        with self.assertRaises(policy.GuardError):policy.validate_container(state,'ollama',value)


class LifecycleTests(unittest.TestCase):
    def test_import_guard_proof_requires_exact_current_foreground_parent(self):
        state = fixture(); state['phase'] = 'READY_FOR_LOAD_IMPORT'; state['workflowHistory'] = ['pilot']
        for i, service in enumerate(policy.SERVICES): add_resource(state, service, identifier=str(i + 1) * 64)
        state['processes'] = {service: process_record(state, service) for service in ['api', 'workers']}
        state['acceptanceSources']['load-import-runtime.mjs'] = '6' * 64
        state['loadProcess'] = {**process_record(state, 'load'), 'workflow': 'pilot'}
        with patch.object(main, 'verify_pins'), patch.object(main, 'owned'), patch.object(main, 'verify_schema'), \
                patch.object(main, 'process_alive', return_value=True), \
                patch.object(main, 'scoped_fixture', return_value=load_fixture(state)), \
                patch.object(main, 'assert_catalog_scope'), patch.object(main.os, 'getppid', return_value=987654):
            self.assertEqual(main.guard(state, 'import', require_caller=True), {'schemaVersion': 1,
                'namespace': policy.NAMESPACE, 'runId': RUN, 'purpose': 'import', 'resourceOwnership': True,
                'databaseReadOnly': True, 'bootstrapFreshness': False,
                'experimentPolicyId':state['experimentPolicyId'],'experimentPolicySha256':state['experimentPolicySha256']})
            with patch.object(main.os, 'getppid', return_value=987655):
                with self.assertRaisesRegex(policy.GuardError, 'load-guard-exact-foreground-parent'):
                    main.guard(state, 'import', require_caller=True)

    def test_catalog_scope_accepts_only_two_organizations_with_global_caps(self):
        state = fixture(); saved = load_fixture(state)
        baseline = {'organizations': 2, 'outsideOrganizations': 0, 'users': 3, 'outsideUsers': 0,
            'superadmins': 0, 'keys': 0, 'documents': 240, 'outsideDocuments': 0, 'collections': 20,
            'outsideCollections': 0, 'members': sorted([{'id': row['memberId'], 'userId': row['userId'],
                'organizationId': row['organizationId']} for row in saved['users'].values()], key=lambda row: row['id'])}
        with patch.object(main, 'db_query', return_value=baseline) as query:
            main.assert_catalog_scope(state, saved)
        self.assertIn('public."Document"', query.call_args.args[1])
        for changed in [{'documents': 241}, {'collections': 21}, {'outsideDocuments': 1}, {'outsideUsers': 1},
                {'members': []}, {'keys': 1}]:
            with patch.object(main, 'db_query', return_value={**baseline, **changed}):
                with self.assertRaisesRegex(policy.GuardError, 'load-exact-synthetic-catalog-bound'):
                    main.assert_catalog_scope(state, saved)

    def test_full_admission_requires_real_complete_pilot_with_fixed_projection(self):
        state = fixture(); main.validate_pilot_admission(pilot_report(), state)
        mutations = [lambda r: r.update(evidenceKind='SYNTHETIC_UNIT_TEST'),
            lambda r: r.update(acceptance='NOT_RUN'), lambda r: r.update(runId='f' * 12),
            lambda r: r['timing'].update(pilotIndexMs=144001),
            lambda r: r['pilotObservation'].update(physicalChildren=1999),
            lambda r: r['pilotObservation'].update(validatedNativeVectors=0),
            lambda r: r['pilotObservation'].update(peakMemoryBytes=0),
            lambda r: r['pilotObservation'].update(minimumFreeBytes=4 * 1024 ** 3 - 1),
            lambda r: r['pilotObservation'].update(resourcePolicySha256='f' * 64),
            lambda r: r['pilotObservation'].update(errors=1)]
        for mutate in mutations:
            report = pilot_report(); mutate(report)
            with self.assertRaises(policy.GuardError): main.validate_pilot_admission(report, state)
        boundary = pilot_report(); boundary['timing']['pilotIndexMs'] = 144000
        main.validate_pilot_admission(boundary, state)
        changed_state = fixture(); changed_state['commit'] = 'a' * 40
        with self.assertRaisesRegex(policy.GuardError, 'load-measured-pilot-prerequisite'):
            main.validate_pilot_admission(pilot_report(), changed_state)

    def test_foreground_identity_is_saved_before_exec_with_no_replay(self):
        state = fixture(); events = []
        state['acceptanceSources']['load-import-runtime.mjs'] = 'a' * 64
        with patch.object(main, 'guard'), patch.object(main, 'free_space'), \
                patch.object(main, 'process_identity', return_value={'startTicks': '123456'}), \
                patch.object(main.Path, 'is_file', return_value=True), patch.object(main.Path, 'is_symlink', return_value=False), \
                patch.object(main.Path, 'read_text', return_value='12345678-1234-1234-1234-123456789abc'), \
                patch.object(main, 'entry_digest', return_value='a' * 64), patch.object(main.os, 'getpid', return_value=987654), \
                patch.object(main, 'save', side_effect=lambda s: events.append('saved')), \
                patch.object(main.os, 'chdir'), patch.object(main.os, 'execvpe', side_effect=lambda *args: events.append(args)):
            main.foreground_load(state, 'pilot')
        self.assertEqual(events[0], 'saved')
        self.assertEqual(state['workflowHistory'], ['pilot'])
        self.assertEqual(state['loadProcess']['service'], 'load')
        self.assertEqual(events[1][1][-2:], ['--mode', 'pilot'])
        self.assertEqual(events[1][2]['VECTORIX_LOAD_RUN'], RUN)
        self.assertEqual(events[1][2]['VECTORIX_LOAD_ROLE'], 'load')
        with patch.object(main, 'guard') as guard:
            with self.assertRaisesRegex(policy.GuardError, 'load-refuses-ambiguous-workflow-replay'):
                main.foreground_load(state, 'pilot')
            guard.assert_not_called()

    def test_traffic_requires_complete_new_native_full_and_same_resource_policy(self):
        state = fixture(); main.validate_full_admission(full_report(), state)
        mutations = [lambda r: r.update(evidenceKind='SYNTHETIC_UNIT_TEST'),
            lambda r: r.update(acceptance='NOT_RUN'), lambda r: r.update(workflow='pilot'),
            lambda r: r.update(runId='f' * 12), lambda r: r['timing'].update(fullIndexMs=7200001),
            lambda r: r['fullObservation'].update(physicalChildren=99999),
            lambda r: r['fullObservation'].update(validatedNativeVectors=99999),
            lambda r: r['fullObservation'].update(parents=24999),
            lambda r: r['fullObservation'].update(retries=1),
            lambda r: r['fullObservation'].update(errors=1),
            lambda r: r['fullObservation'].update(resourcePolicySha256='f' * 64),
            lambda r: r['fullObservation'].update(minimumFreeBytes=4 * 1024 ** 3 - 1),
            lambda r: r['fullObservation'].update(peakMemoryBytes=0),
            lambda r: r['fullObservation'].update(manifestSha256='invalid'),
            lambda r: r['collections']['primary'].update(generationId='pilot-generation'),
            lambda r: r['collections']['primary'].update(activeChildren=99999),
            lambda r: r['collections'].update(pilot=None),
            lambda r: r['collections']['pilot'].update(activeChildren=1999),
            lambda r: r.update(fullObservation=None),
            lambda r: r.update(documents=None),
            lambda r: r['documents']['loadA'].pop(),
            lambda r: r['documents']['loadA'][1].update(documentId='document-0')]
        for mutate in mutations:
            report = full_report(); mutate(report)
            with self.assertRaises(policy.GuardError): main.validate_full_admission(report, state)
        boundary = full_report(); boundary['timing']['fullIndexMs'] = 7200000
        main.validate_full_admission(boundary, state)
        changed_state = fixture(); changed_state['commit'] = 'a' * 40
        with self.assertRaisesRegex(policy.GuardError, 'load-measured-full-prerequisite'):
            main.validate_full_admission(full_report(), changed_state)

    def test_traffic_process_record_requires_complete_order_and_dedicated_entry(self):
        state = fixture(); state['workflowHistory'] = ['pilot', 'full', 'traffic']
        state['acceptanceSources']['load-traffic-runtime.mjs'] = '6' * 64
        saved = process_record(state, 'load'); saved.update(workflow='traffic',
            entry=str(HERE / 'load-traffic-runtime.mjs'))
        state['loadProcess'] = saved
        policy.validate_state(state, RUN)
        for mutate in [lambda s: s.update(workflowHistory=['pilot', 'traffic']),
                lambda s: s['loadProcess'].update(entry=str(HERE / 'load-import-runtime.mjs')),
                lambda s: s['loadProcess'].update(entrySha256='f' * 64),
                lambda s: s['loadProcess'].update(workflow='full')]:
            changed = copy.deepcopy(state); mutate(changed)
            with self.assertRaises(policy.GuardError): policy.validate_state(changed, RUN)

    def test_traffic_foreground_validates_full_before_recording_and_refuses_replay(self):
        state = fixture(); state['workflowHistory'] = ['pilot', 'full']; events = []
        state['acceptanceSources']['load-traffic-runtime.mjs'] = 'a' * 64
        with patch.object(main, 'guard'), patch.object(main, 'free_space'), \
                patch.object(main, 'process_identity', return_value={'startTicks': '123456'}), \
                patch.object(main.Path, 'is_file', return_value=True), patch.object(main.Path, 'is_symlink', return_value=False), \
                patch.object(main.Path, 'read_text', return_value='12345678-1234-1234-1234-123456789abc'), \
                patch.object(main, 'read_private_bytes', return_value=json.dumps(full_report()).encode()) as read, \
                patch.object(main, 'entry_digest', return_value='a' * 64), patch.object(main.os, 'getpid', return_value=987654), \
                patch.object(main, 'save', side_effect=lambda s: events.append('saved')), \
                patch.object(main.os, 'chdir'), patch.object(main.os, 'execvpe', side_effect=lambda *args: events.append(args)):
            main.foreground_load(state, 'traffic')
        self.assertEqual(read.call_args.args[0].name, 'load-full-report.json')
        self.assertEqual(events[0], 'saved')
        self.assertEqual(state['workflowHistory'], ['pilot', 'full', 'traffic'])
        self.assertEqual(state['loadProcess']['entry'], str(HERE / 'load-traffic-runtime.mjs'))
        self.assertEqual(events[1][1][-2:], ['--mode', 'traffic'])
        with patch.object(main, 'guard') as guard:
            with self.assertRaisesRegex(policy.GuardError, 'load-refuses-ambiguous-workflow-replay'):
                main.foreground_load(state, 'traffic')
            guard.assert_not_called()

    def test_traffic_missing_or_failed_report_cannot_record_a_caller(self):
        state = fixture(); state['workflowHistory'] = ['pilot', 'full']
        with patch.object(main, 'guard'), patch.object(main, 'free_space'), \
                patch.object(main, 'read_private_bytes', return_value=json.dumps(pilot_report()).encode()), \
                patch.object(main, 'save') as save, patch.object(main.os, 'execvpe') as execute:
            with self.assertRaisesRegex(policy.GuardError, 'load-live-full-report-required'):
                main.foreground_load(state, 'traffic')
        save.assert_not_called(); execute.assert_not_called()
        self.assertEqual(state['workflowHistory'], ['pilot', 'full'])

    def test_draft_gate_precedes_arguments_resources_files_and_processes(self):
        with patch.object(main, 'DRAFT_ONLY', True), \
             patch.object(main,'prepare') as prepare,patch.object(main,'read_state') as read, \
             patch.object(main,'state_lock') as lock:
            with self.assertRaisesRegex(policy.GuardError,'load-topology-draft-awaiting-root-review'):main.main()
            prepare.assert_not_called();read.assert_not_called();lock.assert_not_called()

    def test_enabled_cli_refuses_invalid_arguments_before_state_or_resources(self):
        with patch.object(main, 'DRAFT_ONLY', False), patch.object(sys, 'argv', ['load-topology.py']), \
             patch.object(main, 'prepare') as prepare, patch.object(main, 'read_state') as read, \
             patch.object(main, 'state_lock') as lock, patch.object(sys, 'stderr'):
            with self.assertRaises(SystemExit) as caught: main.main()
            self.assertEqual(caught.exception.code, 2)
            prepare.assert_not_called(); read.assert_not_called(); lock.assert_not_called()

    def test_create_records_volume_then_exact_id_before_start(self):
        state=fixture();events=[]
        def inspect(name,kind='container'):
            return volume(state,'redis') if kind=='volume' else container(state,'redis',False)
        def command(args,**kwargs):
            events.append(('command',args[:3]))
            if args[:2]==['docker','create']:return b'a'*64
            return b''
        with patch.object(main,'inspect',side_effect=inspect),patch.object(main,'command_result',return_value={'exitCode':1}), \
             patch.object(main,'run',side_effect=command),patch.object(main,'owned'), \
             patch.object(main,'save',side_effect=lambda s:events.append(('save',s['resources']['redis']['id']))):
            main.create_service(state,'redis')
        first=events.index(('save',None));second=events.index(('save','a'*64))
        create=next(i for i,v in enumerate(events) if v==('command',['docker','create','--pull=never']))
        start=next(i for i,v in enumerate(events) if v==('command',['docker','start','a'*64]))
        self.assertLess(first,create);self.assertLess(create,second);self.assertLess(second,start)

    def test_start_failure_keeps_exact_owned_id_for_cleanup(self):
        state=fixture();events=[]
        def command(args,**kwargs):
            events.append(args)
            if args[:2]==['docker','create']:return b'a'*64
            if args[:2]==['docker','start']:raise policy.GuardError('synthetic-start-failure')
            return b''
        with patch.object(main,'inspect',return_value=volume(state,'redis')),patch.object(main,'command_result',return_value={'exitCode':1}), \
             patch.object(main,'run',side_effect=command),patch.object(main,'owned'),patch.object(main,'save'):
            with self.assertRaisesRegex(policy.GuardError,'synthetic-start-failure'):main.create_service(state,'redis')
        self.assertEqual(state['resources']['redis']['id'],'a'*64)
        with patch.object(main,'stop_apps'),patch.object(main,'save'), \
             patch.object(main,'owned',return_value={'State':{'Running':False}}), \
             patch.object(main,'inspect',return_value=volume(state,'redis')),patch.object(main,'run',return_value=b'') as run:
            main.cleanup(state)
        self.assertIn(['docker','rm','a'*64],[item.args[0] for item in run.call_args_list])
        self.assertIn(['docker','volume','rm',state['prefix']+'-redis-data'],[item.args[0] for item in run.call_args_list])

    def test_cleanup_refuses_unrecorded_named_container_before_volume_removal(self):
        state=fixture();add_resource(state,'redis',identifier=None)
        with patch.object(main,'stop_apps'),patch.object(main,'save'),patch.object(main,'run',return_value=b'unknown') as run:
            with self.assertRaisesRegex(policy.GuardError,'load-unrecorded-same-name-container'):main.cleanup(state)
        self.assertFalse(any(call.args[0][:3]==['docker','volume','rm'] for call in run.call_args_list))

    def test_model_container_last_and_model_cache_never_removed(self):
        state=fixture()
        for i,service in enumerate(policy.SERVICES):add_resource(state,service,identifier=str(i+1)*64)
        volumes={saved['volume']:volume(state,service) for service,saved in state['resources'].items()}
        with patch.object(main,'stop_apps'),patch.object(main,'save'), \
             patch.object(main,'owned',return_value={'State':{'Running':False}}), \
             patch.object(main,'inspect',side_effect=lambda name,kind:volumes[name]),patch.object(main,'run',return_value=b'') as run:
            proof=main.cleanup(state)
        commands=[item.args[0] for item in run.call_args_list]
        removed=[args[2] for args in commands if args[:2]==['docker','rm']]
        self.assertEqual(removed[-1],'5'*64)
        self.assertFalse(any(args[:3]==['docker','volume','rm'] and args[-1]=='operator-model-volume' for args in commands))
        self.assertTrue(proof['modelVolumePreserved']);self.assertEqual(state['resources'],{})

    def test_bootstrap_guard_has_no_nested_lock_and_requires_empty_catalog(self):
        state=fixture();state['phase']='BOOTSTRAPPING';state['processes']['api']=process_record(state)
        for i,service in enumerate(policy.SERVICES):add_resource(state,service,identifier=str(i+1)*64)
        with patch.object(main,'verify_pins'),patch.object(main,'owned'),patch.object(main,'verify_schema'), \
             patch.object(main,'assert_empty'),patch.object(main,'process_alive',return_value=True),patch.object(main,'state_lock') as lock:
            proof=main.guard(state,'bootstrap')
        self.assertEqual(proof,{'schemaVersion':1,'namespace':policy.NAMESPACE,'runId':RUN,'purpose':'bootstrap',
            'resourceOwnership':True,'databaseReadOnly':True,'bootstrapFreshness':True,
            'experimentPolicyId':state['experimentPolicyId'],'experimentPolicySha256':state['experimentPolicySha256']});lock.assert_not_called()
        with patch.object(main,'db_query',return_value={'users':1,'organizations':0,'members':0,'roles':0,'keys':0,'documents':0,'collections':0}):
            with self.assertRaisesRegex(policy.GuardError,'load-bootstrap-requires-empty-catalog'):main.assert_empty(state)

    def test_readonly_query_cannot_send_mutation_or_wrong_database(self):
        state=fixture();add_resource(state,'postgres')
        with patch.object(main,'owned',return_value={'Id':'a'*64}),patch.object(main,'run',return_value=b'true') as run:
            self.assertTrue(main.db_query(state,'SELECT to_json(true)'))
        command=run.call_args.args[0]
        self.assertIn(state['applicationDatabase'],command);self.assertIn('PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000',command)
        with patch.object(main,'owned') as owned:
            with self.assertRaises(policy.GuardError):main.db_query(state,'DELETE FROM public.member')
            owned.assert_not_called()

    def test_process_record_and_live_identity_refuse_reused_or_foreign_processes(self):
        state=fixture();saved=process_record(state);state['processes']['api']=saved
        policy.validate_state(state,RUN)
        for key,value in [('service','workers'),('entry','/usr/bin/node'),('cwd','/tmp'),('pid',1),('entrySha256','f'*64)]:
            altered=copy.deepcopy(state);altered['processes']['api'][key]=value
            with self.assertRaises(policy.GuardError):policy.validate_state(altered,RUN)
        identity={'startTicks':saved['startTicks'],'command':[b'node',saved['entry'].encode()],
            'cwd':saved['cwd'],'uid':0,'environment':[(key+'='+value).encode() for key,value in state['environment'].items()]+
                [('VECTORIX_LOAD_RUN='+RUN).encode(),b'VECTORIX_LOAD_ROLE=api',b'PORT=45106']}
        with patch.object(main.Path,'read_text',return_value=saved['bootId']), \
             patch.object(main,'process_identity',return_value=identity),patch.object(main.os,'getuid',return_value=0), \
             patch.object(main,'entry_digest',return_value=saved['entrySha256']):
            self.assertTrue(main.process_alive(state,saved))
            identity['startTicks']='different'
            self.assertFalse(main.process_alive(state,saved))
            identity['startTicks']=saved['startTicks'];identity['environment'].append(b'VECTORIX_LOAD_RUN=foreign')
            with self.assertRaisesRegex(policy.GuardError,'load-process-run-markers'):main.process_alive(state,saved)
            identity['environment'].pop();identity['environment'].append(b'DATABASE_URL=foreign')
            with self.assertRaisesRegex(policy.GuardError,'load-process-runtime-environment'):main.process_alive(state,saved)

    def test_zombie_process_never_reads_command_or_environment(self):
        with patch.object(main.Path,'read_text',return_value='987654 (node) Z 1 2 3'), \
             patch.object(main.Path,'read_bytes') as read:
            self.assertIsNone(main.process_identity(987654));read.assert_not_called()

    def test_child_nonzero_or_fabricated_summary_is_never_success(self):
        state=fixture()
        for result in [{'data':b'{"completed":true,"runId":"abcdef012345"}','exitCode':1},
                {'data':b'{"completed":true,"runId":"ffffffffffff"}','exitCode':0},
                {'data':b'RAW_SECRET','exitCode':0}]:
            with patch.object(main,'bounded_stream',return_value=result):
                with self.assertRaises(policy.GuardError):main.child(state,'load-bootstrap.mjs')

    def test_child_arguments_are_exact_and_unknown_program_refused(self):
        state=fixture()
        with patch.object(main,'bounded_stream',return_value={'data':json.dumps({'completed':True,'runId':RUN}).encode(),'exitCode':0}) as call:
            main.child(state,'load-bootstrap.mjs',timeout=180)
            self.assertEqual(call.call_args.args[0][-4:],['--run',RUN,'--experiment','DEFAULT_V1'])
            self.assertNotIn('--state',call.call_args.args[0])
            main.child(state,'load-bucket.mjs')
            self.assertEqual(call.call_args.args[0][-4:],['--state',str(policy.state_path(RUN)),'--run',RUN])
            with self.assertRaises(policy.GuardError):main.child(state,'collector.mjs')


class VariantTests(unittest.TestCase):
    def test_registry_exact_policy_namespace_and_paths_reject_cross_variant(self):
        default,light=fixture(),fixture('LIGHT_V1')
        self.assertEqual(policy.validate_state(default,RUN),default)
        self.assertEqual(policy.validate_state(light,RUN),light)
        self.assertNotEqual(policy.state_path(RUN),policy.state_path(RUN,'LIGHT_V1'))
        self.assertEqual(default['loadPolicy'],policy.LOAD_POLICY)
        self.assertEqual(light['loadPolicy']['profile']['targetTokens'],128)
        self.assertEqual(light['loadPolicy']['fullSeconds'],7200)
        for alter in [lambda s:s.pop('experimentPolicyId'),lambda s:s.pop('experimentPolicySha256'),
                lambda s:s.update(experimentPolicyId='DEFAULT_V1'),lambda s:s.update(namespace=policy.NAMESPACE),
                lambda s:s['loadPolicy']['profile'].update(targetTokens=512),
                lambda s:s.update(corpusFiles={'load-v1/full-preflight.json':'8'*64}),
                lambda s:s.update(applicationDatabase=default['applicationDatabase']),
                lambda s:s['environment'].update(VECTORIX_DEFAULT_S3_BUCKET='m7c-load-'+RUN)]:
            value=copy.deepcopy(light);alter(value)
            with self.assertRaises(policy.GuardError):policy.validate_state(value,RUN)

    def test_light_resource_label_and_model_volume_are_separate(self):
        value=fixture('LIGHT_V1');saved=add_resource(value,'postgres');observed=container(value,'postgres')
        policy.validate_volume(value,'postgres',saved);policy.validate_container(value,'postgres',observed)
        self.assertNotEqual(policy.labels(RUN,'postgres'),observed['Config']['Labels'])
        observed['Config']['Labels']=policy.labels(RUN,'postgres')
        with self.assertRaises(policy.GuardError):policy.validate_container(value,'postgres',observed)
        value['modelVolume']['name']='vectorix-m7c-load-'+RUN+'-data'
        with self.assertRaises(policy.GuardError):policy.validate_state(value,RUN)

    def test_light_reports_require_same_descriptor_and_original_projection_gate(self):
        state=fixture('LIGHT_V1');report=pilot_report();selected=policy.load_policy_for_state(state)
        report.update(namespace=state['namespace'],experimentPolicyId=selected['id'],policySha256=policy.policy_sha256(selected),
            corpusSha256=selected['identity']['pilot'],familySha256=selected['identity']['family'])
        report['pilotObservation']['resourcePolicySha256']=main.load_resource_policy_hash(state)
        report['collections']['pilot']['policySha256']=state['experimentPolicySha256']
        main.validate_pilot_admission(report,state)
        report['timing']['pilotIndexMs']=144001
        with self.assertRaisesRegex(policy.GuardError,'projection'):main.validate_pilot_admission(report,state)
        for changes in [dict(policySha256='0'*64),dict(experimentPolicyId='DEFAULT_V1'),dict(namespace=policy.NAMESPACE),
                dict(corpusSha256=policy.LOAD_POLICY['pilotCorpusSha256'])]:
            bad=copy.deepcopy(report);bad['timing']['pilotIndexMs']=140000;bad.update(changes)
            with self.assertRaises(policy.GuardError):main.validate_pilot_admission(bad,state)

    def test_new_reports_cannot_swap_collection_roles_or_borrow_another_policy_receipt(self):
        for report,validator,key in [(pilot_report(),main.validate_pilot_admission,'pilot'),(full_report(),main.validate_full_admission,'primary')]:
            validator(report,fixture())
            for changes in [dict(collectionRole='ingestionA'),dict(policySha256=policy.policy_sha256(policy.get_load_policy('LIGHT_V1'))),dict(policySha256=None)]:
                bad=copy.deepcopy(report);bad['collections'][key].update(changes)
                with self.assertRaises(policy.GuardError):validator(bad,fixture())

    def test_light_fixture_exact_explicit_experiment_and_auth_memberships(self):
        state=fixture('LIGHT_V1');value=load_fixture(state)
        policy.validate_fixture(value,state)
        for changes in [dict(experimentPolicyId='DEFAULT_V1'),dict(experimentPolicySha256='0'*64),dict(namespace=policy.NAMESPACE)]:
            with self.assertRaises(policy.GuardError):policy.validate_fixture({**value,**changes},state)

    def test_read_state_cannot_adopt_other_experiment_from_wrong_directory(self):
        state=fixture('LIGHT_V1')
        with patch.object(policy,'read_private_bytes',return_value=json.dumps(state).encode()):
            with self.assertRaisesRegex(policy.GuardError,'load-state-path-experiment'):policy.read_state(RUN)
            self.assertEqual(policy.read_state(RUN,'LIGHT_V1'),state)

    def test_light_initial_state_keeps_caps_and_exact_bindings(self):
        source=fixture('LIGHT_V1')
        with patch.object(main,'helper_manifest',return_value=source['acceptanceSources']),patch.object(main,'migration_manifest',return_value=source['migrations']):
            state=main.initial_state(RUN,source['ports'],source['images'],source['modelVolume'],source['builds'],source['commit'],experiment_id='LIGHT_V1')
        self.assertEqual(state['loadPolicy'],source['loadPolicy'])
        self.assertEqual(state['applicationDatabase'],source['applicationDatabase'])
        self.assertEqual(state['experimentPolicySha256'],source['experimentPolicySha256'])
        self.assertEqual(len(state['corpusFiles']),56)
        self.assertTrue(all(key.startswith(('reference-v1/','light-v1/')) for key in state['corpusFiles']))

if __name__=='__main__':unittest.main(verbosity=2)
