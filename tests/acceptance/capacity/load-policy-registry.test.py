"""Pure closed-registry parity checks; Node child imports only the pure local registry."""
import ast
import copy
import json
import os
from pathlib import Path
import subprocess
import unittest
import load_policy_registry as registry

HERE=Path(__file__).resolve().parent
ROOT=next(parent for parent in HERE.parents if (parent/'pnpm-workspace.yaml').is_file())

class RegistryTests(unittest.TestCase):
    def test_actual_javascript_and_python_have_exact_descriptor_and_hash_parity(self):
        module=(HERE/'load-policy-registry.mjs').as_uri()
        code='import {getLoadPolicy,policySha256} from '+json.dumps(module)+';console.log(JSON.stringify(["DEFAULT_V1","LIGHT_V1"].map(id=>({descriptor:getLoadPolicy(id),sha256:policySha256(getLoadPolicy(id))}))));'
        result=subprocess.run(['node','--input-type=module','-e',code],cwd=ROOT,env={'PATH':os.environ.get('PATH','')},capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,'pure registry child refused')
        self.assertLess(len(result.stdout),16384)
        actual=json.loads(result.stdout)
        expected=[{'descriptor':registry.get_load_policy(key),'sha256':registry.policy_sha256(registry.get_load_policy(key))} for key in ['DEFAULT_V1','LIGHT_V1']]
        self.assertEqual(actual,expected)

    def test_default_policy_is_semantically_identical_to_historical_tracked_literal(self):
        tree=ast.parse((ROOT/'tests/acceptance/capacity/load_topology_policy.py').read_text())
        expressions=[n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='LOAD_POLICY' for t in n.targets)]
        # The historical source currently owns the literal; after promotion the explicit baseline is retained here.
        if isinstance(expressions[0],ast.Dict):
            old=eval(compile(ast.Expression(expressions[0]),'<reviewed-literal>','eval'),{'__builtins__':{}},{})
            self.assertEqual(registry.get_load_policy('DEFAULT_V1')['loadPolicy'],old)
        self.assertEqual(registry.policy_sha256(registry.get_load_policy('DEFAULT_V1')),'79b3d1b3d0b170294b9ff6b871c1cba6164ed2622900b7e7724724512003526e')

    def test_unknown_and_mutated_descriptors_reject_without_registry_mutation(self):
        for key in ['default','native-light-load-v1','',None,True]:
            with self.assertRaises(registry.LoadPolicyError):registry.get_load_policy(key)
        p=registry.get_load_policy('LIGHT_V1');p['controlChunking']['targetTokens']=128
        with self.assertRaises(registry.LoadPolicyError):registry.policy_sha256(p)
        self.assertEqual(registry.get_load_policy('LIGHT_V1')['controlChunking']['targetTokens'],512)

    def test_no_boolean_float_or_missing_field_canonical_policy_bypass(self):
        p=registry.get_load_policy('DEFAULT_V1')
        for mutation in [lambda v:v.update(fullSeconds=7200.0),lambda v:v.update(extra=False),lambda v:v.update(pilotDocuments=True)]:
            s={'experimentPolicyId':p['id'],'experimentPolicySha256':registry.policy_sha256(p),'namespace':p['namespace'],'loadPolicy':copy.deepcopy(p['loadPolicy'])}
            mutation(s['loadPolicy'])
            with self.assertRaises(registry.LoadPolicyError):registry.load_policy_for_state(s)

    def test_exact_role_geometry_and_unchanged_cost_gates(self):
        for key in ['DEFAULT_V1','LIGHT_V1']:
            p=registry.get_load_policy(key)
            for role in registry.COLLECTION_ROLES:
                profile=registry.collection_chunking(p,role)
                is_light=key=='LIGHT_V1' and role in ['pilotA','primaryA']
                self.assertEqual(profile['targetTokens'],128 if is_light else 512)
                self.assertEqual(profile['parentMaxTokens'],512 if is_light else 2048)
            with self.assertRaises(registry.LoadPolicyError):registry.collection_chunking(p,'owner')
            self.assertEqual(p['loadPolicy']['pilotSeconds'],1200)
            self.assertEqual(p['loadPolicy']['fullSeconds'],7200)
            self.assertEqual(p['loadPolicy']['maximumDocuments'],240)

if __name__=='__main__':unittest.main(verbosity=2)
