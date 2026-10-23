"""Closed offline experiment registry. No file, environment, process or client I/O."""
from __future__ import annotations
import copy
import hashlib
import json

class LoadPolicyError(ValueError):
    """Finite refusal for an unreviewed or mismatched experiment descriptor."""

def _need(value):
    if not value:
        raise LoadPolicyError('LOAD_EXPERIMENT_POLICY')

def _canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()

_REGISTRY = {'DEFAULT_V1': {'id': 'DEFAULT_V1',
                'policyVersion': 'native-default-load-v1',
                'namespace': 'vectorix-m7c-load',
                'version': 'm7c-load-v1',
                'identity': {'family': '4f64a77bb49dc1e547aa37fc438507bcfee2a894697424357eb61f4f47bedbfb',
                             'pilot': '0d008fd0514aac362e888aa6a582daef1cd0b3feb4cf26e6a3d096faaee0627c',
                             'full': 'c99db8842d4ab7a52457c8e81926389f7d66b49d569db026ed548fe841f01a67',
                             'reference': 'cb372b53964ffe896bb4e3c3c44831db6c0949bbe622e63ce0a482607be6fdbc',
                             'weights': '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1'},
                'documentIdPrefix': 'm7c-load-v1-d',
                'documentBytes': 672192,
                'corpusRoot': 'load-v1',
                'minimumContextTokens': {'primary': 1608, 'control': 1608},
                'primaryChunking': {'targetTokens': 512,
                                    'minTokens': 128,
                                    'maxTokens': 768,
                                    'overlapTokens': 64,
                                    'semanticPercentile': 90,
                                    'parentMaxTokens': 2048},
                'controlChunking': {'targetTokens': 512,
                                    'minTokens': 128,
                                    'maxTokens': 768,
                                    'overlapTokens': 64,
                                    'semanticPercentile': 90,
                                    'parentMaxTokens': 2048},
                'emailPrefix': 'm7c-load',
                'databasePrefix': 'vectorix_m7c_load',
                'label': 'vectorix.load-test',
                'loadPolicy': {'version': 'native-default-load-v1',
                               'maximumDocuments': 240,
                               'maximumCollections': 20,
                               'primaryDocuments': 200,
                               'referenceDocuments': 24,
                               'concurrentDocuments': 12,
                               'pilotDocuments': 4,
                               'pilotChildren': 2000,
                               'fullChildren': 100000,
                               'familySha256': '4f64a77bb49dc1e547aa37fc438507bcfee2a894697424357eb61f4f47bedbfb',
                               'pilotCorpusSha256': '0d008fd0514aac362e888aa6a582daef1cd0b3feb4cf26e6a3d096faaee0627c',
                               'fullCorpusSha256': 'c99db8842d4ab7a52457c8e81926389f7d66b49d569db026ed548fe841f01a67',
                               'model': {'provider': 'OLLAMA',
                                         'model': 'embeddinggemma:latest',
                                         'dimensions': 768,
                                         'preset': 'EMBEDDING_GEMMA',
                                         'digest': '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1'},
                               'profile': {'strategy': 'TOKEN_WINDOW',
                                           'targetTokens': 512,
                                           'minTokens': 128,
                                           'maxTokens': 768,
                                           'overlapTokens': 64,
                                           'parentMaxTokens': 2048,
                                           'parentChild': True,
                                           'preparation': '',
                                           'indexType': 'DISKANN'},
                               'pilotSeconds': 1200,
                               'fullSeconds': 7200,
                               'phaseSeconds': 180,
                               'phaseDrainSeconds': 300,
                               'minimumFreeBytes': 4294967296,
                               'resourceSampling': {'minimumIntervalMs': 1000,
                                                    'maximumSamples': 20000,
                                                    'maximumBytes': 33554432},
                               'gracefulStopSeconds': 300}},
 'LIGHT_V1': {'id': 'LIGHT_V1',
              'policyVersion': 'native-light-load-v1',
              'namespace': 'vectorix-m7c-light-load',
              'version': 'm7c-light-v1',
              'identity': {'family': '66b2c83297a39f7e805ec5cf1fad2bc30297a0610570b8d06a6090285d8913d0',
                           'pilot': '14dd2e0bdcf31e55bff8c0ce6d018bdd42a42d12482c804cd1c9813a44b5d577',
                           'full': '5a6d27a0ffdf1acf558f327f3197257e7dcc9216e4717cd70d26de825138f0f2',
                           'reference': 'cb372b53964ffe896bb4e3c3c44831db6c0949bbe622e63ce0a482607be6fdbc',
                           'weights': '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1'},
              'documentIdPrefix': 'm7c-light-v1-d',
              'documentBytes': 168048,
              'corpusRoot': 'light-v1',
              'minimumContextTokens': {'primary': 457, 'control': 1608},
              'primaryChunking': {'targetTokens': 128,
                                  'minTokens': 32,
                                  'maxTokens': 192,
                                  'overlapTokens': 16,
                                  'semanticPercentile': 90,
                                  'parentMaxTokens': 512},
              'controlChunking': {'targetTokens': 512,
                                  'minTokens': 128,
                                  'maxTokens': 768,
                                  'overlapTokens': 64,
                                  'semanticPercentile': 90,
                                  'parentMaxTokens': 2048},
              'emailPrefix': 'm7c-light-load',
              'databasePrefix': 'vectorix_m7c_light_load',
              'label': 'vectorix.light-load-test',
              'loadPolicy': {'version': 'native-light-load-v1',
                             'maximumDocuments': 240,
                             'maximumCollections': 20,
                             'primaryDocuments': 200,
                             'referenceDocuments': 24,
                             'concurrentDocuments': 12,
                             'pilotDocuments': 4,
                             'pilotChildren': 2000,
                             'fullChildren': 100000,
                             'familySha256': '66b2c83297a39f7e805ec5cf1fad2bc30297a0610570b8d06a6090285d8913d0',
                             'pilotCorpusSha256': '14dd2e0bdcf31e55bff8c0ce6d018bdd42a42d12482c804cd1c9813a44b5d577',
                             'fullCorpusSha256': '5a6d27a0ffdf1acf558f327f3197257e7dcc9216e4717cd70d26de825138f0f2',
                             'model': {'provider': 'OLLAMA',
                                       'model': 'embeddinggemma:latest',
                                       'dimensions': 768,
                                       'preset': 'EMBEDDING_GEMMA',
                                       'digest': '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1'},
                             'profile': {'strategy': 'TOKEN_WINDOW',
                                         'targetTokens': 128,
                                         'minTokens': 32,
                                         'maxTokens': 192,
                                         'overlapTokens': 16,
                                         'parentMaxTokens': 512,
                                         'parentChild': True,
                                         'preparation': '',
                                         'indexType': 'DISKANN'},
                             'pilotSeconds': 1200,
                             'fullSeconds': 7200,
                             'phaseSeconds': 180,
                             'phaseDrainSeconds': 300,
                             'minimumFreeBytes': 4294967296,
                             'resourceSampling': {'minimumIntervalMs': 1000,
                                                  'maximumSamples': 20000,
                                                  'maximumBytes': 33554432},
                             'gracefulStopSeconds': 300}}}
COLLECTION_ROLES = ('pilotA','primaryA','referenceB','ingestionA','ingestionB')

def get_load_policy(policy_id):
    _need(type(policy_id) is str and policy_id in _REGISTRY)
    return copy.deepcopy(_REGISTRY[policy_id])

def policy_sha256(policy):
    _need(type(policy) is dict and type(policy.get('id')) is str and policy['id'] in _REGISTRY
        and _canonical(policy) == _canonical(_REGISTRY[policy['id']]))
    return hashlib.sha256(_canonical(policy)).hexdigest()

def load_policy_for_state(state):
    _need(type(state) is dict)
    policy = get_load_policy(state.get('experimentPolicyId'))
    _need(state.get('experimentPolicySha256') == policy_sha256(policy)
        and state.get('namespace') == policy['namespace']
        and _canonical(state.get('loadPolicy')) == _canonical(policy['loadPolicy']))
    return policy

def collection_chunking(policy, role):
    policy_sha256(policy)
    _need(role in COLLECTION_ROLES)
    return copy.deepcopy(policy['primaryChunking'] if role in ('pilotA','primaryA') else policy['controlChunking'])
