import type{StartCommand}from'../bridge/protocol.js';import{discoveryProposal,type DiscoveryProposal}from'../contracts/discovery-proposal.js';import{parseArtifact,validateValues}from'../contracts/artifact.js';import{resolveBindings}from'../replay/bindings.js';import{evaluateCheck}from'../replay/checks.js';import type{Capture}from'../contracts/observation.js';import type{DurableTarget}from'../contracts/artifact.js';
export type RecordedAction={call_id:string,tool:string,input:any,target?:DurableTarget,result:any};
export type DiscoveryContext={deployment:StartCommand['deployment'],capability_catalog:any[],inputs:Record<string,unknown>,records:RecordedAction[],references:DiscoveryProposal['reference_assets'],recordReference?:(record:any,crop:Buffer,capture:Capture,callId:string)=>Promise<void>,proposal?:DiscoveryProposal};
const stable=(v:any):string=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
export function verifyProposal(raw:unknown,c:DiscoveryContext,capture:Capture):DiscoveryProposal{
 const p=discoveryProposal.parse(raw),a=parseArtifact(p.definition);const selection=p.capability_selection;
 const contract=selection.mode==='reuse'?c.capability_catalog.find(x=>x.capability_id===selection.capability_id):selection;
 if(!contract)throw Error('CAPABILITY_UNKNOWN');if(stable(contract.input_schema)!==stable(a.input_schema)||stable(contract.output_schema)!==stable(a.output_schema))throw Error('CAPABILITY_SCHEMA_DRIFT');
 const values=validateValues(a.input_schema,p.parameter_values),outputs=validateValues(a.output_schema,p.observed_outputs);
 for(const[key,value]of Object.entries(c.inputs))if(stable(value)!==stable(values[key]))throw Error('EXPLICIT_INPUT_CONFLICT');
 if(a.compatibility.product_id!==c.deployment.product_id||a.compatibility.ui_variant!==c.deployment.ui_variant||a.compatibility.vendor_release!==c.deployment.vendor_release)throw Error('ARTIFACT_INCOMPATIBLE');
 const results:Record<string,any>={},environment={base_url:c.deployment.base_url};let index=0;
 for(const s of a.steps){
  while(index<c.records.length&&c.records[index]!.tool!==s.tool&&['observe_ui','check_ui','wait_for','extract_data'].includes(c.records[index]!.tool))index++;
  const record=c.records[index++];if(!record||record.tool!==s.tool)throw Error('UNOBSERVED_PLAN_STEP');
  const args=resolveBindings(s.arguments,values,results,environment);
  if(s.tool==='extract_data'){for(const field of s.arguments.fields){const observed=record.input.fields.find((f:any)=>f.name===field.name);if(!observed||field.property!==observed.property||field.output_type!==observed.output_type)throw Error('UNOBSERVED_PLAN_ARGUMENT');const target=c.records.find(r=>r.call_id===record.call_id)?.input._durable_fields?.[field.name];if(!target||!equivalentTarget(field.target,target,values,results,environment))throw Error('UNOBSERVED_PLAN_TARGET');}}
  else{for(const[key,value]of Object.entries(args))if(stable(value)!==stable(record.input[key]))throw Error('UNOBSERVED_PLAN_ARGUMENT');if(s.target&&(!record.target||!equivalentTarget(s.target,record.target,values,results,environment)))throw Error('UNOBSERVED_PLAN_TARGET');}
  if(!['completed','ok','evaluated','condition_met'].includes(record.result.status))throw Error('UNVERIFIED_DISCOVERY_TOOL');results[s.step_id]=record.result;
 }
 if(c.records.slice(index).some(r=>['navigate','click','type_text','press_key','scroll','select_option'].includes(r.tool)))throw Error('UNRECORDED_MUTATION');
 const context={inputs:values,results,environment};if(a.success_checks.some(check=>evaluateCheck(check,capture,context).verdict!=='pass'))throw Error('DISCOVERY_CHECK_FAILED');
 const mapped=validateValues(a.output_schema,resolveBindings(a.output_mapping,values,results,environment));if(stable(mapped)!==stable(outputs))throw Error('DISCOVERY_OUTPUT_MISMATCH');
 p.parameter_values=values;p.observed_outputs=outputs;p.reference_assets=c.references;return p;
}
function equivalentTarget(saved:any,recorded:any,inputs:any,results:any,environment:any){if(saved.kind!==recorded.kind)return false;if(saved.kind==='visual')return saved.asset_id===recorded.asset_id&&saved.sha256===recorded.sha256&&stable(saved.relative_point)===stable(recorded.relative_point)&&stable(saved.capture_context)===stable(recorded.capture_context)&&saved.matcher===recorded.matcher&&saved.threshold===recorded.threshold;return saved.role===recorded.role&&resolveBindings(saved.name,inputs,results,environment)===recorded.name.value&&(saved.scope===null||stable(saved.scope)===stable(recorded.scope));}
