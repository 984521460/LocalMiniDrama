'use strict';
const {createHash}=require('node:crypto');
const {canonicalCharacterCandidateExecutionRequest,parseCharacterCandidateExecutionRequest}=require('../../../characterCandidates/execution/request');
const {parseCharacterCandidateSource,characterCandidateSourceSha256}=require('../../../characterCandidates/execution/source');
const {createCharacterCandidatePrompt}=require('../../../characterCandidates/execution/prompt');
const {normalizeNarrativeResult}=require('../../../narrative/reviews/contracts');
const sha=value=>createHash('sha256').update(value).digest('hex');
function validateCollections(records,invalid,base=null){
 const collections=new Map(records.characterRemoteCollections.map(row=>[row.operation_uid,row]));
 for(const collection of collections.values()){
  let request,source;try{request=parseCharacterCandidateExecutionRequest(collection.request_json);source=parseCharacterCandidateSource(collection.source_json);}catch{invalid();}
  if(collection.binding_state!=='needs_rebind'||request.operationUid!==collection.operation_uid||request.dramaUid!==collection.drama_uid||request.characterUid!==collection.character_uid
    ||sha(canonicalCharacterCandidateExecutionRequest(request))!==collection.request_sha256||characterCandidateSourceSha256(source)!==collection.source_sha256
    ||source.dramaUid!==request.dramaUid||source.characterUid!==request.characterUid||source.extractionResultUid!==request.extractionResultUid||source.characterFactId!==request.characterFactId)invalid();
  const result=records.narrativeResults.find(row=>row.uid===source.extractionResultUid);
  const review=records.narrativeReviewEvents.find(row=>`review:v1:${row.uid}`===source.extractionApprovalRef);
  if(!result||result.result_hash!==source.extractionResultHash||result.envelope_hash!==source.extractionEnvelopeHash||result.source_selection_uid!==source.sourceSelectionUid||!review||review.result_uid!==result.uid||review.decision!=='approve')invalid();
  let fact;try{fact=normalizeNarrativeResult('extraction',result.result_json).output.characters.find(item=>item.factId===source.characterFactId);}catch{invalid();}
  if(!fact||fact.name!==source.characterFactName||fact.description!==source.characterFactDescription)invalid();
  const binding=collection.binding_json;
  if(!binding||Object.keys(binding).sort().join(',')!=='connectionEvidenceSha256,connectionUid,profileSha256'||!/^[0-9a-f-]{36}$/.test(binding.connectionUid)||!['connectionEvidenceSha256','profileSha256'].every(key=>/^[0-9a-f]{64}$/.test(binding[key])))invalid();
  const jobs=records.characterRemoteCollectionJobs.filter(job=>job.operation_uid===collection.operation_uid);
  if(jobs.length>4)invalid();
  const execution=records.characterCandidateExecutions.find(row=>row.operation_uid===collection.operation_uid);
  if(!execution||execution.request_sha256!==collection.request_sha256||execution.source_sha256!==collection.source_sha256)invalid();
  const completed=execution.state==='succeeded';
  if(completed&&(jobs.length!==4||jobs.some(j=>j.state!=='collected')))invalid();
  for(const [ordinal,job] of jobs.entries()){
   const seed=(request.seed+ordinal*2654435761)%4294967296;
   if(job.ordinal!==ordinal||job.prompt_sha256!==createCharacterCandidatePrompt(source,ordinal,seed).promptSha256||!['submitting','submitted','output_bound','collected'].includes(job.state))invalid();
   if(ordinal<jobs.length-1&&job.state!=='collected')invalid();
   if(job.state==='submitting'){if(job.prompt_id!==null||job.output_json!==null||job.item_json!==null)invalid();continue;}
   if(typeof job.prompt_id!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(job.prompt_id))invalid();
   if(job.state==='submitted'){if(job.output_json!==null||job.item_json!==null)invalid();continue;}
   const output=job.output_json;
   if(!output||Object.keys(output).sort().join(',')!=='fileName,nodeId,storageType,subfolder'||output.nodeId!=='7'||output.storageType!=='output'||output.subfolder!==`character-candidates/${request.operationUid}`||!new RegExp(`^${ordinal}_[0-9]{5,}_[.]png$`).test(output.fileName))invalid();
   if(job.state==='output_bound'){if(job.item_json!==null)invalid();continue;}
   const item=job.item_json,relative=`characters/${request.characterUid}/candidate-batches/${request.operationUid}/${ordinal}.png`,logical=`asset://characters/${request.characterUid}/candidate-batches/${request.operationUid}/${ordinal}`;
   if(!item||item.ordinal!==ordinal||item.relativePath!==relative||item.logicalUri!==logical||item.seed!==seed||item.promptSha256!==job.prompt_sha256||item.width!==request.width||item.height!==request.height||item.bytes!==item.byteLength||!Number.isSafeInteger(item.byteLength)||item.byteLength<1||item.byteLength>16777216||!/^[0-9a-f]{64}$/.test(item.contentSha256))invalid();
   if(base){
    const asset=base.assets.find(a=>a.uid===item.assetUid),version=base.assetVersions.find(v=>v.uid===item.assetVersionUid);
    if(!asset||!version||asset.owner_type!=='character'||asset.owner_uid!==request.characterUid||asset.asset_type!=='character_candidate'||version.asset_uid!==asset.uid||version.relative_path!==relative||version.logical_uri!==logical||version.sha256!==item.contentSha256||version.mime_type!=='image/png'||version.width!==request.width||version.height!==request.height||version.status!=='ready'||asset.status!==(completed?'ready':'draft')||asset.current_version_uid!==(completed?version.uid:null))invalid();
   }
  }
 }
 if(records.characterRemoteCollectionJobs.some(job=>!collections.has(job.operation_uid)))invalid();
}
module.exports={validateCollections};
