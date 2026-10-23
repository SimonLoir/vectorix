"""Independent resource/phase guard for the static S3 child. No import-time I/O."""
import argparse,json,sys
from m7c_restore_common import (GuardError,read_json,validate_state,state_path,require,owned_container,no_apps)
STATIC_DRAFT_ONLY=False

def main():
 require(not STATIC_DRAFT_ONLY,'static-object-guard-not-execution-approved')
 parser=argparse.ArgumentParser();parser.add_argument('--state',required=True);parser.add_argument('--run',required=True);parser.add_argument('--mode',required=True)
 args=parser.parse_args();path=state_path(args.run);require(str(path)==args.state,'exact-object-state-path')
 state=validate_state(read_json(path),args.run)
 source=args.mode in ['initialize-source','export','verify-source'];side='source' if source else 'target'
 phases={'initialize-source':['source-empty-approved-schema-setup-required'],'export':['source-available-for-approved-dashboard-setup','capture-in-progress'],'verify-source':['source-available-for-approved-dashboard-setup','capture-in-progress','source-exported-still-quiescent'],'restore':['empty-target-infrastructure','restore-in-progress'],'verify-target':['restored-not-yet-verified','restored-verified-before-replay']}
 require(args.mode in phases and state['phase'] in phases[args.mode],'object-phase')
 no_apps(state)
 for service in ['postgres','vector','redis','rustfs']:owned_container(state,side,service,running=True)
 if side=='target':
  for service in ['postgres','vector','redis','rustfs']:owned_container(state,'source',service,running=False)
  require(state['resources']['source']['rustfs']['volumeIdentity']!=state['resources']['target']['rustfs']['volumeIdentity'],'distinct-target-object-volume')
 print(json.dumps({'runId':state['runId'],'side':side,'phase':state['phase'],'resourcesOwned':True}))

if __name__=='__main__':
 try:main()
 except Exception as error:
  print(json.dumps({'completed':False,'diagnostic':error.args[0] if isinstance(error,GuardError) else 'sanitized-object-guard-failure'}),file=sys.stderr)
  raise SystemExit(1) from None
