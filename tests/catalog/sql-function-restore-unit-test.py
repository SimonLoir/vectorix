"""Pure refusal checks; no Docker, database, process or provider is invoked."""
import copy
import importlib.util
from pathlib import Path
import unittest

MODULE = Path(__file__).with_name('sql-function-restore-check.py')
SPEC = importlib.util.spec_from_file_location('sql_function_restore_check', MODULE)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

PREFIX = 'vectorix-catalog-12345-56789'
IMAGE = 'sha256:' + 'a' * 64


def container(side):
    return {
        'Name': '/' + PREFIX + ('-postgres' if side == 'source' else '-restore-postgres'),
        'Id': ('b' if side == 'source' else 'c') * 64,
        'Image': IMAGE,
        'State': {'Running': True},
        'Config': {'Labels': {check.LABEL: PREFIX}},
        'HostConfig': {'Privileged': False, 'NetworkMode': 'none' if side == 'target' else 'bridge', 'PortBindings': {}},
        'Mounts': [{'Type': 'volume', 'Name': side + '-anonymous-volume', 'Destination': '/var/lib/postgresql', 'RW': True}],
    }


class OwnedRestoreTests(unittest.TestCase):
    def test_source_and_distinct_network_isolated_target(self):
        source = check.validate_container(container('source'), PREFIX, 'source')
        target = check.validate_container(container('target'), PREFIX, 'target', source_image=IMAGE)
        self.assertNotEqual(source, target)

    def test_refuse_foreign_labels_names_privilege_and_bind_mounts(self):
        mutations = [
            lambda value: value['Config']['Labels'].clear(),
            lambda value: value.update(Name='/application-postgres'),
            lambda value: value['HostConfig'].update(Privileged=True),
            lambda value: value['Mounts'][0].update(Type='bind'),
            lambda value: value['Mounts'][0].update(Destination='/var/lib/postgresql/data'),
        ]
        for mutate in mutations:
            value = copy.deepcopy(container('source'))
            mutate(value)
            with self.subTest(value=value), self.assertRaises(check.GuardError):
                check.validate_container(value, PREFIX, 'source')

    def test_refuse_target_image_network_and_published_port_drift(self):
        for mutate in [
            lambda value: value.update(Image='sha256:' + 'd' * 64),
            lambda value: value['HostConfig'].update(NetworkMode='host'),
            lambda value: value['HostConfig'].update(PortBindings={'5432/tcp': [{'HostPort': '5432'}]}),
        ]:
            value = container('target')
            mutate(value)
            with self.assertRaises(check.GuardError):
                check.validate_container(value, PREFIX, 'target', source_image=IMAGE)

    def test_stopped_target_is_cleanup_only_and_still_owned(self):
        value = container('target')
        value['State']['Running'] = False
        with self.assertRaises(check.GuardError):
            check.validate_container(value, PREFIX, 'target', source_image=IMAGE)
        check.validate_container(value, PREFIX, 'target', source_image=IMAGE, allow_stopped=True)
        value['Config']['Labels'].clear()
        with self.assertRaises(check.GuardError):
            check.validate_container(value, PREFIX, 'target', source_image=IMAGE, allow_stopped=True)

    def test_generated_sql_identifiers_reject_escape_syntax(self):
        self.assertEqual(check.identifier('SemanticChunkPlan'), '"SemanticChunkPlan"')
        self.assertEqual(check.identifier('_prisma_migrations'), '"_prisma_migrations"')
        for value in ['public.Chunk', '"Chunk"', 'Chunk;DELETE', 'a' * 64, '', 'é', None]:
            with self.assertRaises(check.GuardError):
                check.identifier(value)


if __name__ == '__main__':
    unittest.main(verbosity=2)
