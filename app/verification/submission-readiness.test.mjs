import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidateSubmission, makeSubmissionRecord, submissionReadiness } from '../submission-readiness.mjs';

const guide = {path:'办理通道说明.pdf',hash:'guide-v1',role:'other'};
const form = {path:'申请表.pdf',hash:'form-v1',role:'form'};
const proof = {path:'营业执照.pdf',hash:'proof-v1',role:'identity'};
const claimant = {path:form.path,sha256:form.hash,field:'申请人',value:'夹具主体'};
const matched = {path:proof.path,sha256:proof.hash,field:'名称',value:'夹具主体'};
const fixture = () => ({
  target:{version:'V1.0',snapshot:'fixed'},
  entries:[guide,form,proof],
  preflight:{
    report:{files:[guide,form,proof]},
    versionCheck:{groups:{release:[]}},choice:{softwareName:'机械回归样例'},
    applicationCheck:{references:[],items:[
      {id:'identity',status:'review',evidence:[claimant,matched],attachments:[{path:proof.path,sha256:proof.hash}]},
      {id:'rights',status:'missing',evidence:[],attachments:[]},
      {id:'signature',status:'missing',evidence:[],attachments:[]},
    ]},
  },
});
const record = (id, paths, extra={})=>({id,paths,responsible:'夹具材料人',reviewer:'夹具经办人',
  basis:'机械回归夹具用于检查当前记录绑定',channel:'夹具测试渠道',confirmed:true,...extra});
const item = (state,id)=>submissionReadiness(state).items.find(item=>item.id===id);
const read = () => Buffer.alloc(1);

test('channel review uses exact bytes and named reviewer, and never proves other rows',()=>{
  const state = fixture();
  assert.equal(item(state,'identity').reviewable,false);
  assert.throws(()=>makeSubmissionRecord(state,null,record('channel',[form.path]),read));
  assert.throws(()=>makeSubmissionRecord(state,null,record('channel',[guide.path],{reviewer:''}),read));
  assert.throws(()=>makeSubmissionRecord(state,null,record('channel',[guide.path],{confirmed:false}),read));
  state.submission=makeSubmissionRecord(state,null,record('channel',[guide.path]),read);
  assert.equal(item(state,'channel').status,'已复核');
  assert.equal(item(state,'identity').status,'待经办复核');
  state.submission=makeSubmissionRecord(state,null,record('identity',[proof.path]),read);
  assert.equal(item(state,'identity').status,'已复核');
  assert.equal(submissionReadiness(state).ready,false);
  const update = {...proof,hash:'proof-v2'};
  state.submission=invalidateSubmission(state,[guide,form,update]);
  state.entries=[guide,form,update];
  state.preflight.report.files=state.entries;
  assert.equal(item(state,'identity').status,'原复核失效');
  assert.equal(item(state,'channel').status,'已复核');
  state.entries=[guide,form,proof];
  state.preflight.report.files=state.entries;
  assert.equal(item(state,'identity').status,'原复核失效');
  state.submission=invalidateSubmission(state,[form,proof]);
  state.entries=[form,update];
  state.preflight.report.files=state.entries;
  assert.equal(item(state,'channel').status,'原复核失效');
  assert.equal(item(state,'identity').reviewable,false);
});

test('version, conflict, and channel applicability keep prior records separate',()=>{
  const state = fixture();
  state.submission=makeSubmissionRecord(state,null,record('channel',[guide.path]),read);
  assert.equal(item(state,'other').status,'待经办复核');
  state.submission=makeSubmissionRecord(state,null,record('other',[guide.path],{notApplicable:true}),read);
  assert.equal(item(state,'other').status,'不适用');
  state.preflight.applicationCheck.items[0].status='conflict';
  assert.equal(item(state,'other').status,'发现冲突');
  assert.equal(item(state,'identity').reviewable,false);
  assert.equal(submissionReadiness(state).ready,false);
  state.target.version='V1.1';
  assert.equal(item(state,'channel').status,'原复核失效');
});

test('submission readiness uses the confirmed title and invalidates a review scoped to the old title',()=>{
  const state = fixture();
  state.submission = makeSubmissionRecord(state,null,record('channel',[guide.path]),read);
  state.softwareName = '本案确认的软件全称';
  assert.equal(submissionReadiness(state).software,state.softwareName);
  assert.equal(item(state,'channel').status,'原复核失效');
});

test('deposit review binds a complete verified uploaded set to the current files',()=>{
  const state = fixture();
  state.submission = makeSubmissionRecord(state,null,record('channel',[guide.path]),read);
  const source = {path:'自备源程序.pdf',kind:'uploaded-source-pdf',hash:'source-v1'};
  const manual = {path:'自备说明书.pdf',kind:'uploaded-manual-pdf',hash:'manual-v1'};
  const reference = {path:'交存源码－全部.pdf',kind:'source-pdf',hash:'reference-v1',volume:'all'};
  const audit = {
    allowed:[source,manual,reference],sourceVolumes:['all'],runtimeEvidence:{status:'部分已对照'},
    verifiedSources:[{path:source.path,sha256:source.hash,volume:'all'}],
    verifiedManuals:[{path:manual.path,sha256:manual.hash,status:'逐项结果已对照'}],
  };
  const deposit = record('deposit',[source.path,manual.path]);
  assert.throws(()=>makeSubmissionRecord(state,audit,record('deposit',[source.path,reference.path,manual.path]),read),/一整套/);
  state.submission = makeSubmissionRecord(state,audit,deposit,read);
  assert.equal(submissionReadiness(state,audit).items.find(item=>item.id==='deposit').status,'已复核');

  const replacedSource = {...source,hash:'source-v2'};
  const changed = {...audit,allowed:[replacedSource,manual,reference]};
  assert.throws(()=>makeSubmissionRecord(state,changed,deposit,read),/选择本案卷当前附件/);
  assert.equal(submissionReadiness(state,changed).items.find(item=>item.id==='deposit').status,'原复核失效');
});
