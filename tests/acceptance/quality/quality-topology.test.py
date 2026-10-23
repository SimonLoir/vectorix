"""Offline synthetic/mocked lifecycle tests. Never calls Docker, HTTP, DB, provider or real processes."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import quality_topology_policy as policy
spec = importlib.util.spec_from_file_location('quality_topology', HERE / 'quality-topology.py')
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)
RUN = 'abcdef012345'


def fixture():
    ports = dict(postgres=45101, vector=45102, redis=45103, rustfs=45104, ollama=45105, api=45106, web=45107, admin=45108)
    secret = {key: 'a' * 32 for key in ['postgres', 'indexer', 'runtime', 's3Secret']}
    secret['s3Access'] = 'm7c-quality-' + RUN
    api, web = 'http://127.0.0.1:45106', 'http://127.0.0.1:45107'
    environment = dict.fromkeys(policy.ENVIRONMENT_KEYS, '')
    environment.update(NODE_ENV='production', TZ='UTC', VECTORIX_TIME_ZONE='UTC',
        DATABASE_URL=f'postgresql://postgres:{secret["postgres"]}@127.0.0.1:45101/vectorix_m7c_quality_app_{RUN}_test',
        VECTOR_DATABASE_URL=f'postgresql://vectorix_runtime:{secret["runtime"]}@127.0.0.1:45102/vectorix_m7c_quality_vectors_{RUN}_test',
        VECTOR_DATABASE_PROVISIONING_URL=f'postgresql://vectorix_indexer:{secret["indexer"]}@127.0.0.1:45102/vectorix_m7c_quality_vectors_{RUN}_test',
        VECTOR_DATABASE_SCHEMA='vector_collections', REDIS_URL='redis://127.0.0.1:45103',
        BETTER_AUTH_SECRET='b' * 64, ENCRYPTION_SECRET='c' * 64,
        BETTER_AUTH_URL=api, API_URL=api, VECTORIX_WEB_URL=web, TRUSTED_ORIGINS=web,
        ALLOW_ACCOUNT_CREATION='true', ALLOW_ORGANIZATION_CREATION='true', VECTORIX_WEB_PUSH_ENABLED='false',
        VECTORIX_DEFAULT_S3_ENDPOINT='http://127.0.0.1:45104', VECTORIX_DEFAULT_S3_REGION='us-east-1',
        VECTORIX_DEFAULT_S3_BUCKET='m7c-quality-' + RUN, VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE='true',
        VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=secret['s3Access'], VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=secret['s3Secret'],
        VECTORIX_S3_ALLOWED_ENDPOINTS='http://127.0.0.1:45104', VECTORIX_DEFAULT_OLLAMA_ENDPOINT='http://127.0.0.1:45105',
        VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS='http://127.0.0.1:45105', PASSKEY_RP_ID='127.0.0.1',
        PASSKEY_RP_NAME='Vectorix isolated quality acceptance', PASSKEY_ORIGINS=web)
    state = {'schemaVersion': 1, 'namespace': policy.NAMESPACE, 'runId': RUN, 'prefix': policy.NAMESPACE + '-' + RUN,
        'phase': 'PREPARING', 'ports': ports, 'images': {name: 'sha256:' + 'd' * 64 for name in policy.SERVICES},
        'resourceLimits': copy.deepcopy(policy.DEFAULT_LIMITS), 'resources': {}, 'processes': {}, 'dashboardProcesses': {},
        'collectorProcess': None, 'infrastructureSecrets': secret, 'commit': 'e' * 40, 'lockfileSha256': 'f' * 64,
        'prismaConfigSha256': '1' * 64, 'migrations': {'20261021000000_initial': '2' * 64},
        'acceptanceSources': {'quality-topology.py': '3' * 64}, 'corpusDigest': '4' * 64,
        'modelVolume': {'name': 'operator-model-volume', 'identity': '5' * 64}, 'builds': {},
        'applicationDatabase': 'vectorix_m7c_quality_app_' + RUN + '_test',
        'vectorDatabase': 'vectorix_m7c_quality_vectors_' + RUN + '_test', 'apiOrigin': api, 'webOrigin': web,
        'environment': environment}
    for service in ['api', 'workers', 'web']:
        entry = policy.ROOT / ('apps/' + service + '/dist/index.mjs' if service != 'web'
            else 'apps/web/.next/standalone/apps/web/server.js')
        state['builds'][service] = {'entry': str(entry), 'entrySha256': '6' * 64, 'treeSha256': '7' * 64, 'treeFiles': 1}
    return state


def process_record(state, service='api'):
    entry = state['builds'][service]['entry'] if service != 'collector' else str(HERE / 'collector.mjs')
    return {'pid': 987654, 'startTicks': '123456', 'bootId': '12345678-1234-1234-1234-123456789abc',
        'entry': entry, 'entrySha256': '6' * 64, 'cwd': str(Path(entry).parent) if service != 'collector' else str(policy.ROOT),
        'service': service}


def volume(state, service):
    return {'Name': state['modelVolume']['name'] if service == 'ollama' else state['prefix'] + '-' + service + '-data',
        'CreatedAt': '2026-01-01T00:00:00Z', 'Driver': 'local', 'Options': None,
        'Labels': {'operator': 'preserve'} if service == 'ollama' else policy.labels(RUN, service)}


def add_resource(state, service, *, identifier='a' * 64):
    value = volume(state, service)
    if service == 'ollama': state['modelVolume']['identity'] = policy.volume_identity(value)
    state['resources'][service] = {'name': state['prefix'] + '-' + service, 'id': identifier,
        'imageId': state['images'][service], 'volume': value['Name'], 'volumeIdentity': policy.volume_identity(value)}
    return value


def container(state, service, running=True):
    saved = state['resources'][service]
    return {'Id': saved['id'], 'Name': '/' + saved['name'], 'Image': state['images'][service],
        'State': {'Running': running}, 'Config': {'Labels': policy.labels(RUN, service)},
        'HostConfig': {'NetworkMode': 'bridge', 'Privileged': False, 'VolumesFrom': None, 'Links': None,
            'NanoCpus': policy.nano_cpus(state['resourceLimits'][service]['cpus']),
            'Memory': state['resourceLimits'][service]['memoryBytes'],
            'PortBindings': {str(policy.SERVICES[service][0]) + '/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(state['ports'][service])}]}},
        'Mounts': [{'Type': 'volume', 'Name': saved['volume'], 'Destination': policy.SERVICES[service][1], 'RW': service != 'ollama'}]}


class PolicyTests(unittest.TestCase):
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
    def test_draft_gate_precedes_arguments_resources_files_and_processes(self):
        self.assertFalse(main.DRAFT_ONLY)
        with patch.object(main, 'DRAFT_ONLY', True), patch.object(main,'prepare') as prepare,patch.object(main,'read_state') as read, \
             patch.object(main,'state_lock') as lock:
            with self.assertRaisesRegex(policy.GuardError,'quality-topology-draft-awaiting-root-review'):main.main()
            prepare.assert_not_called();read.assert_not_called();lock.assert_not_called()

    def test_enabled_cli_rejects_invalid_run_before_resources_or_private_state(self):
        with patch.object(main.sys, 'argv', ['quality-topology.py', '--run', 'invalid', '--mode', 'guard']), \
                patch.object(main, 'private_directory') as private, patch.object(main, 'read_state') as read, \
                patch.object(main, 'guard') as guard, patch.object(main, 'run') as run:
            with self.assertRaisesRegex(policy.GuardError, 'quality-run-format'):
                main.main()
            private.assert_not_called(); read.assert_not_called(); guard.assert_not_called(); run.assert_not_called()

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
            with self.assertRaisesRegex(policy.GuardError,'quality-unrecorded-same-name-container'):main.cleanup(state)
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
            'resourceOwnership':True,'databaseReadOnly':True,'bootstrapFreshness':True});lock.assert_not_called()
        with patch.object(main,'db_query',return_value={'users':1,'organizations':0,'members':0,'roles':0,'keys':0,'documents':0,'collections':0}):
            with self.assertRaisesRegex(policy.GuardError,'quality-bootstrap-requires-empty-catalog'):main.assert_empty(state)

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
                [('VECTORIX_QUALITY_RUN='+RUN).encode(),b'VECTORIX_QUALITY_ROLE=api',b'PORT=45106']}
        with patch.object(main.Path,'read_text',return_value=saved['bootId']), \
             patch.object(main,'process_identity',return_value=identity),patch.object(main.os,'getuid',return_value=0), \
             patch.object(main,'entry_digest',return_value=saved['entrySha256']):
            self.assertTrue(main.process_alive(state,saved))
            identity['startTicks']='different'
            self.assertFalse(main.process_alive(state,saved))
            identity['startTicks']=saved['startTicks'];identity['environment'].append(b'VECTORIX_QUALITY_RUN=foreign')
            with self.assertRaisesRegex(policy.GuardError,'quality-process-run-markers'):main.process_alive(state,saved)
            identity['environment'].pop();identity['environment'].append(b'DATABASE_URL=foreign')
            with self.assertRaisesRegex(policy.GuardError,'quality-process-runtime-environment'):main.process_alive(state,saved)

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
                with self.assertRaises(policy.GuardError):main.child(state,'quality-bootstrap.mjs')

    def test_child_arguments_are_exact_and_unknown_program_refused(self):
        state=fixture()
        with patch.object(main,'bounded_stream',return_value={'data':json.dumps({'completed':True,'runId':RUN}).encode(),'exitCode':0}) as call:
            main.child(state,'quality-bootstrap.mjs',timeout=180)
            self.assertEqual(call.call_args.args[0][-2:],['--run',RUN])
            self.assertNotIn('--state',call.call_args.args[0])
            main.child(state,'quality-bucket.mjs')
            self.assertEqual(call.call_args.args[0][-4:],['--state',str(policy.state_path(RUN)),'--run',RUN])
            with self.assertRaises(policy.GuardError):main.child(state,'collector.mjs')


if __name__=='__main__':unittest.main(verbosity=2)
