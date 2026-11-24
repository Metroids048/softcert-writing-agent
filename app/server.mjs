import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, JSZip, inspectFiles, closeWorker, readerPaths, runtimeIdentity } from './runtime.mjs';
import { blobStore, expandUploads, readUpload, stamp, maxFiles, maxBytes, digest } from './files.mjs';
import { composeSource, sourceSelection, renderManual, microblog, sourceSkillPaths, historicalReview } from './compose.mjs';
import { auditCandidate, validateDownload, ruleVersion } from './audit.mjs';
import { scanTranscript } from './scan-ocr.mjs';
import { filingAssetPaths, fixedSourceProfile, selectFilingSource, selectPackagedSource, composeFilingDocuments,
  selectSelfPreparedSource, selfReviewInput } from './filing.mjs';
import { originalFeatures } from './filing/feature-evidence.mjs';
import { checkSourceBooklets } from './source-check.mjs';
import { isRuntimeEvidence, operationFacts, reviewRuntimeEvidence, runtimeLaunch } from './runtime-evidence.mjs';
import { checkVersions, versionReport } from './version-check.mjs';
import { checkApplication, applicationRow, applicationActions, applicationReport } from './application-check.mjs';
import { invalidateSubmission, makeSubmissionRecord, submissionReadiness, submissionReport } from './submission-readiness.mjs';
import { materialTitles, materialIntent, requestName, reviewOnlyRequest } from './deliverables.mjs';
import { automaticExclusions } from './filing/source-scope.mjs';
import { packagedWebProofCurrent, staticWebRelease } from './filing/packaged-web.mjs';
import { correctionNotices, correctionStatus, makeCorrection, correctionReport } from './corrections.mjs';

process.umask(0o077);
const storage = process.env.SOFTCERT_DATA || join(root,'.workbench');
mkdirSync(storage,{recursive:true,mode:0o700});
const blobs = blobStore(join(storage,'blobs'));
const db = new DatabaseSync(join(storage,'cases.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL);
`);
const active = new Map();
const method = 'workbench/0.3.37';
const hollowArchive = '45711c082fd89c2b275380364f0f624669314d9f55d10e977595a67f0b88a4c5';
const hollowReviewedManual = '9f75c350febc6f132f1fafc322ca3080b311f907fdcf02cf1161013773927db8';
const policyPaths = ['audit.mjs','compose.mjs','runtime.mjs','files.mjs','server.mjs','intake-paths.mjs',
    'scan-ocr.mjs','scan-ocr.swift','source-check.mjs','runtime-evidence.mjs','version-check.mjs','application-check.mjs',
    'submission-readiness.mjs','corrections.mjs','filing/self-review.mjs','deliverables.mjs','start.sh','index.html']
  .map(path=>join(root,'app',path)).concat(filingAssetPaths,readerPaths,
    join(root,'.agents/skills/softcert-writing/SKILL.md'),
    join(root,'.agents/skills/softcert-writing/references/stage-prompts.md'),
    sourceSkillPaths);
const readConfiguration = () => ({
  files:Object.fromEntries(policyPaths.concat(existsSync(historicalReview) ? [historicalReview] : [])
    .map(path=>[path,digest(readFileSync(path))])),
  runtime:runtimeIdentity(),
});
const configuration = readConfiguration();
const currentPolicy = () => stamp(readConfiguration());
const policy = stamp(configuration);
const ui = readFileSync(join(root,'app/index.html'));
const intakePaths = readFileSync(join(root,'app/intake-paths.mjs'));
let origin;

class HttpError extends Error {
  constructor(status,message) { super(message); this.status = status; }
}

function requireCurrentPolicy() {
  try { if (currentPolicy() === policy) return; }
  catch (error) { console.error(error.message); }
  throw new HttpError(409,'工作台配置已变更，请重启本地服务后预检并复验。');
}

function get(id) {
  const row = db.prepare('SELECT state FROM cases WHERE id=?').get(id);
  if (!row) throw new HttpError(404,'找不到案卷。');
  return JSON.parse(row.state);
}

function persist(state) {
  const payload = JSON.stringify(state);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO cases VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(state.id,payload);
    db.prepare('INSERT INTO events(id,stage,state) VALUES (?,?,?)').run(state.id,state.stage,payload);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return state;
}

function currentAudit(state, receipt) {
  return state.policy === policy && validateDownload(state,receipt) && packagedWebProofCurrent(state,blobs.read);
}

function visible(state) {
  const {candidate,audit,entries,preflight,...progress} = state;
  const current = state.policy === policy;
  const valid = audit && currentAudit(state,audit.id);
  return {...progress,entries,preflight:current ? preflight : null,candidate:candidate && {id:candidate.id, changes:candidate.changes,
    pending:candidate.pending, upstream:candidate.upstream, count:candidate.files.length},
    submission:valid ? audit.submission : current ? submissionReadiness(state) : null,
    correction:current ? {notices:correctionNotices(state),items:valid ? audit.corrections : correctionStatus(state)} : null,
    audit:audit && {...audit, valid:!!valid}, busy:active.get(state.id) ?? null};
}

function json(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}

function uniqueEntries(state) {
  const first = new Map();
  const duplicates = [];
  for (const file of state.entries) {
    if (isRuntimeEvidence(file.path)) continue;
    if (first.has(file.hash)) duplicates.push({path:file.path,original:first.get(file.hash).path});
    else first.set(file.hash,file);
  }
  return {unique:[...first.values()],duplicates};
}

const loaded = files => files.map(file=>({...file,bytes:blobs.read(file)}));
const inputStamp = state => stamp({entries:state.entries,target:state.target,softwareName:state.softwareName,request:state.request,
  materialSelection:state.materialSelection,submission:state.submission,corrections:state.corrections});
function reset(state,patch) {
  const current = {...state,...patch,revision:(state.revision ?? 0)+1,stage:'uploaded',
    policy, method, candidate:null, audit:null, preflight:null, lastError:null};
  current.inputStamp = inputStamp(current);
  return persist(current);
}

async function preflight(state) {
  const {unique,duplicates} = uniqueEntries(state);
  const inspected = await inspectFiles(origin,loaded(unique),'preflight',true);
  const {report} = inspected;
  const selectedTarget = state.target;
  const pinned = unique.some(file=>file.container?.hash === microblog.archiveSha256) &&
    await sourceSelection({...state,target:{snapshot:microblog.commit,version:selectedTarget?.version}},
      {},blobs,new Map());
  const filing = fixedSourceProfile(state);
  const choice = filing ? {snapshot:filing.source.commit,softwareName:filing.name} :
    pinned ? {snapshot:microblog.commit,softwareName:microblog.softwareName} : null;
  const target = selectedTarget?.snapshot && selectedTarget.snapshot !== choice?.snapshot ?
    {...selectedTarget,snapshot:undefined} : selectedTarget;
  // Save the new binding before a later stage can consume it.
  if (target !== selectedTarget) state = {...state,target};
  const historical = unique.some(file=>file.container?.hash === hollowArchive);
  const sourceConflicts = checkSourceBooklets(inspected,target,
    report.files.filter(file=>file.role === 'source' && /\.pdf$/i.test(file.path)));
  const omissions = automaticExclusions(unique,blobs.read);
  const staticRelease = await staticWebRelease(state,blobs.read);
  const packaged = selectPackagedSource(state,report,inspected.details,omissions,blobs,staticRelease);
  const reviewOnly = reviewOnlyRequest(state.request);
  const legacyDraft = !reviewOnly && (/申请表|底稿|补齐|补写|说明书.{0,12}(?:生成|重写|起草)|(?:生成|起草|写).{0,15}说明书/u.test(state.request) ||
    !!(packaged && !selfReviewInput(state,blobs.read) && /软著|软件著作权|登记|申报/u.test(state.request)));
  const intent = materialIntent(state.request,state.materialSelection,legacyDraft);
  const fixedRun = pinned && target?.snapshot === microblog.commit && target.version === microblog.internalVersion &&
    target.confirmedAt ? microblog : null;
  const versionCheck = await checkVersions(state,inspected,blobs.read,intent.draftRequested,fixedRun,staticRelease);
  const applicationCheck = checkApplication(inspected,versionCheck,
    new Set(unique.filter(file=>file.container?.hash === hollowArchive).map(file=>file.path)));
  report.rows = report.rows.map(row=>row.id === 'R3' ? applicationRow(row,applicationCheck) : row);
  report.actions = [...report.actions.filter(item=>item.id !== 'R3'),...applicationActions(applicationCheck)];
  report.formal = Math.round(report.rows.reduce((sum,row)=>sum+row.formal,0)*1000/report.rows.length)/10;
  const featureSelection = selectFilingSource(state,blobs) || (packaged?.entrypoints.length || packaged?.web || packaged?.pythonDistribution ? packaged :
    await sourceSelection(state,inspected,blobs,omissions) || packaged);
  const features = originalFeatures(state,inspected,featureSelection,blobs.read,omissions);
  const readingGaps = report.files.flatMap(file=>{
    if (!['form','manual','source'].includes(file.role)) return [];
    const gaps = [];
    if (file.truncated) {
      const first = file.readPages+1;
      const last = file.pageCount;
      const pages = first === last ? String(first) : first+'–'+last;
      gaps.push('第 '+pages+' 页未读取（已读取 '+file.readPages+'／'+last+' 页）。');
    }
    if (file.ocr?.unresolved.length) gaps.push('扫描第 '+file.ocr.unresolved.join('、')+' 页需核读原件。');
    for (const feature of features.manuals.find(manual=>manual.path === file.path)?.features ?? []) {
      for (const gap of feature.boundaryGaps) gaps.push('「'+feature.name+'」第 '+gap.from+'、'+gap.to+' 页的操作字段疑有跨页续文，请回读双页。');
    }
    return gaps.map(detail=>({path:file.path,hash:file.hash,detail}));
  });
  const scope = {...intent,mode:intent.draftRequested ? 'draft' : intent.revise ? 'revise' : 'review',readingGaps,features,
    sourceExclusions:[...omissions.values()],
    suggestedName:requestName(state.request) ?? null};
  const prior = state.priorWork;
  const scopeChange = prior && {added:scope.expected.filter(key=>!prior.expected.includes(key)),
    removed:prior.expected.filter(key=>!scope.expected.includes(key)),
    retained:scope.expected.filter(key=>prior.expected.includes(key)),
    earliest:'预检',affected:['预检','候选','终检','取件']};
  const work = {...scope,scopeChange,id:stamp({request:state.request,target,softwareName:state.softwareName,entries:state.entries,...scope})};
  requireCurrentPolicy();
  return persist({...state,preflight:{report,duplicates,choice,historical,sourceConflicts,versionCheck,applicationCheck,packaged,work},
    inputStamp:inputStamp(state),priorWork:undefined,stage:'preflight',lastError:null});
}

async function prepare(state) {
  const {unique} = uniqueEntries(state);
  const {versionCheck,applicationCheck,packaged,work} = state.preflight;
  const omissions = new Map(work.sourceExclusions.map(item=>[item.path,item]));
  const writable = !work.readOnly && !versionCheck.blocking;
  const scoped = work.explicit && !work.readOnly;
  const pathsAllowed = new Set(state.preflight.report.files.filter(file=>!scoped ||
    !Object.hasOwn(materialTitles,file.role) || work.expected.includes(file.role)).map(file=>file.path));
  const revised = await inspectFiles(origin,loaded(unique),writable ? 'revise' : 'readonly-preparation',false,[...pathsAllowed]);
  const {report,authority} = revised;
  const reviewInput = selfReviewInput(state,blobs.read);
  const pending = [...versionCheck.questions,...(revised.deferred ?? []).map(detail=>
    ({id:'R6',owner:'文档整理人',title:'安全写回待处理',detail}))];
  const selectionConflict = state.target && !authority && report.versionEvidence.some(hit=>
    !hit.weak && ['form','manual'].includes(hit.role) && hit.value !== state.target.version);
  const changes = revised.changes ?? [];
  const unrepaired = writable && versionCheck.planned.some(item=>pathsAllowed.has(item.path) && !changes.some(change=>
    change.path === item.path && change.loc === item.location && change.after.includes(item.to)));
  const conflict = versionCheck.blocking || unrepaired || revised.remainingConflict || !!selectionConflict ||
    !!(state.target && authority && state.target.version !== authority.version);
  const authorityConflict = !!(state.target && authority && state.target.version !== authority.version);
  const edits = new Map((authorityConflict || unrepaired ? [] : revised.edits ?? []).map(file=>[file.path,file]));
  const historicalSource = file => state.preflight.historical && file.container?.hash === hollowArchive &&
    /源程序.*历史交存.*\.pdf$/iu.test(file.path);
  const roles = new Map(report.files.map(item=>[item.path,item.role]));
  const uploadedSource = file => roles.get(file.path) === 'source' && /\.pdf$/i.test(file.path);
  const deliveryRole = file => pathsAllowed.has(file.path) && !omissions.has(file.path) && (uploadedSource(file) ||
    (['manual','form'].includes(roles.get(file.path)) && /\.(?:md|txt|docx|pdf)$/i.test(file.path)));
  const candidateFiles = unique.filter(deliveryRole).map(original=>{
    const edit = edits.get(original.path);
    if (edit) return {path:original.path,kind:'editable',...blobs.put(Buffer.from(edit.data,'base64'))};
    if (historicalSource(original) || (state.preflight.historical && !uploadedSource(original))) {
      return {...original,path:'历史研究/'+original.path,originalPath:original.path,
      kind:original.hash === hollowReviewedManual ? 'historical-reviewed-manual' :
        historicalSource(original) ? 'historical-source-original' : 'historical-reference'};
    }
    if (uploadedSource(original)) return {...original,kind:'uploaded-source-pdf'};
    if (roles.get(original.path) === 'manual' && /\.pdf$/i.test(original.path)) {
      return {...original,kind:'uploaded-manual-pdf'};
    }
    if (roles.get(original.path) === 'form' && /\.md$/i.test(original.path)) return {...original,kind:'form-draft'};
    return {...original};
  });
  const originals = new Map(unique.map(file=>[file.path,file]));
  const scans = revised.scans ?? revised.details.filter(item=>item.ocr).map(item=>[item.path,item.ocr]);
  const transcripts = scans.filter(([,ocr])=>ocr.pages.length).map(([path,ocr])=>({
    original:path, path:path+'.OCR.txt', sourceHash:originals.get(path).hash,
    ...blobs.put(scanTranscript(path,ocr)),
  }));
  const addPending = (id,owner,title,detail) => pending.push({id,owner,title,detail});
  if (unrepaired) addPending('R2','经办人 / 文档整理人','替换无法安全写回的稿件',
    '已核对的旧版字段未全部写回。请补同版可编辑稿后重新预检。');
  if (conflict && !versionCheck.blocking && !unrepaired) addPending('R2','开发方 / 经办人','确认目标版本',
    '材料仍有名称或版本冲突，请补同版资料后重新预检。');
  if (state.preflight.historical) {
    addPending('R5','产品 / 开发','补同版构建和运行证据','公开固定源码、历史材料及补正记录可供对照。请补本次实际运行版本的操作证据。');
  }
  let sourceMap;
  let upstream;
  const declared = !conflict && selectSelfPreparedSource(state,reviewInput,blobs.read);
  if (!authority && !state.target?.snapshot && !versionCheck.probes.some(probe=>probe.staticArchive) &&
      !packaged?.pythonDistribution && !declared && revised.reason) {
    addPending('R2','开发方','补发布证据',revised.reason);
  }
  const source = !conflict && !packaged?.sourcePending && (reviewInput ? declared :
    selectFilingSource(state,blobs) || (packaged?.entrypoints.length || packaged?.web || packaged?.pythonDistribution ? packaged :
      await sourceSelection(state,revised,blobs,omissions) || packaged));
  const selection = source && {...source,softwareName:state.softwareName ?? source.softwareName,
    packageName:source.softwareName};
  const sourceInputs = new Map([...originals,...(selection?.web?.supplements ?? []).map(file=>[file.path,file])]);
  const wantsSource = !scoped || work.expected.includes('source');
  const sourceReview = candidateFiles.some(file=>file.kind === 'uploaded-source-pdf');
  if (selection && (wantsSource && !work.readOnly || sourceReview)) {
    try {
      const composed = await composeSource(blobs,[...sourceInputs.values()],selection);
      sourceMap = composed.map;
      upstream = composed.upstream;
      if (selection.sourceSnapshot) addPending('R4','开发方 / 申请人','核准交存全集和权利范围',
        '新册按已确认的 '+selection.paths.length+' 个固定上传文件排版。请确认选定文件覆盖本次拟申报的软件，核准源码量和第三方代码边界。');
      const reserved = new Set(unique.map(file=>file.path));
      for (const file of work.readOnly ? composed.files.filter(file=>file.kind==='source-pdf' && !file.omitted)
        .map(file=>({...file,comparisonOnly:true})) : composed.files) {
        if (file.omitted || reserved.has(file.path)) {
          addPending('R4','开发方','补相应交存件',file.omitted || '交存件与原件同名，保留原件路径。');
        } else candidateFiles.push(file);
      }
    } catch (error) {
      console.error('交存排版失败',String(error.stderr || error.message).slice(0,700));
      addPending('R4','开发方','检查交存排版','固定 Skill 未成功生成交存件，请检查选中的源码或本机依赖。');
    }
  } else if (wantsSource && packaged?.sourcePending) {
    addPending('R4','开发方','恢复本版交存范围凭证',packaged.sourcePending.detail);
  } else if (wantsSource && !work.readOnly && !selection) {
    addPending('R4','开发方','确认交存源码和版本','请补发布记录、同目录 VERSION、对应源码版本标记，或确认识别到的固定源码快照。');
  }
  const target = state.softwareName ? {...state.target ?? authority,softwareName:state.softwareName} : state.target ?? authority;
  const sourceBasis = selection && {software_name:selection.softwareName,package_name:selection.packageName,
    version:selection.version,files:selection.paths.map(path=>({path,sha256:sourceInputs.get(path).hash}))};
  const factBasis = {sourceMap,sourceBasis,target,versionCheck,conflict};
  const runtime = reviewRuntimeEvidence({...state,candidate:factBasis},blobs.read);
  const verifiedFixedRun = work.mode === 'revise' && runtime.records.some(record=>record.reportedCommit &&
    record.status === '部分已对照' && record.steps.every(step=>step.status === '已对照'));
  // The verified fixed run supports internal review of the Word export without a release label.
  for (const file of candidateFiles.slice()) {
    if (!writable || !(authority || verifiedFixedRun) || conflict || !/\.docx$/i.test(file.path) ||
        roles.get(file.path) !== 'manual') continue;
    try {
      const rendered = await renderManual(blobs,file);
      if (candidateFiles.some(existing=>existing.path===rendered.path) || originals.has(rendered.path)) {
        throw new Error('导出路径已被占用。');
      }
      candidateFiles.push(rendered);
    } catch { addPending('R6','文档整理人','检查手册 PDF','未能导出 '+file.path+'，保留可编辑稿。'); }
  }
  const operations = work.draftRequested && !reviewInput && !conflict ? operationFacts(runtime) : [];
  const facts = {features:work.features,runtime,operations,
    launch:work.expected.includes('manual') ?
      runtimeLaunch({...state,candidate:factBasis},operations,blobs.read).launch : []};
  if (work.draftRequested && !conflict && work.expected.some(key=>key !== 'source')) {
    try {
      const basis = {...target,softwareName:state.softwareName ??
        selection?.softwareName ?? authority?.softwareName,confirmedName:state.softwareName};
      const warnings = state.preflight.sourceConflicts.map(hit=>hit.path+' '+hit.location+'。'+hit.detail);
      const sameReleaseManuals = versionCheck.groups.manuscript
        .filter(item=>item.kind === 'archive-member' && item.version === basis.version).map(item=>item.path);
      const documents = await composeFilingDocuments(blobs,basis,revised,unique,work.expected,warnings,sourceMap,applicationCheck,
        reviewInput ? null : facts.features,facts.operations,omissions,state.entries,{...work,sameReleaseManuals,launch:facts.launch});
      if (documents) {
        const reserved = new Set([...originals.keys(),...candidateFiles.map(file=>file.path)]);
        if (documents.files.some(file=>reserved.has(file.path))) throw new Error('申报准备件与现有文件同名。');
        for (const file of candidateFiles) {
          const original = file.originalPath ?? file.path;
          const role = roles.get(original);
          if (work.expected.includes(role) && !(reviewInput && file.kind === 'uploaded-manual-pdf') && documents.superseded.includes(original)) {
            file.supersededByFiling = true;
          }
        }
        candidateFiles.push(...documents.files);
        for (const detail of documents.materialGaps) addPending('R6','开发方 / 文档整理人','补同版说明书证据',detail);
      } else addPending('R6','申请人 / 文档整理人','补充可引用的申报材料',
        '请补能够相互对应的软件全称、版本及实质功能或操作文档。已保留上传原件供核对。');
    } catch (error) {
      console.error('申报准备件生成失败',String(error.stderr || error.message).slice(0,1200));
      addPending('R6','文档整理人','检查申报准备件','未能生成或读回底稿及说明书，原件已保留。');
    }
  }
  const references = unique.filter(file=>!deliveryRole(file));
  const candidate = {files:candidateFiles,references,transcripts,sourceMap,sourceBasis,upstream,conflict,pending,
    versionCheck, applicationCheck, facts, changes:authorityConflict || unrepaired ? [] : changes, target,
    workId:work.id,method,policy,inputStamp:state.inputStamp, createdAt:new Date().toISOString()};
  requireCurrentPolicy();
  return persist({...state,candidate:{...candidate,id:stamp(candidate)},audit:null,stage:'candidate',lastError:null});
}

async function audit(state) {
  const receipt = await auditCandidate({state,origin,read:blobs.read,revision:state.revision});
  requireCurrentPolicy();
  return persist({...state,audit:receipt,stage:'audited',lastError:null});
}

async function readSmallJson(req) {
  const bytes = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16000) throw new HttpError(400,'提交内容超出可保存长度。');
    bytes.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(bytes)); }
  catch { throw new HttpError(400,'无法读取提交内容。'); }
}

async function saveSubmission(state,req) {
  if (state.policy !== policy || !state.preflight?.applicationCheck) throw new HttpError(409,'请先预检当前案卷。');
  const input = await readSmallJson(req);
  if (!input || typeof input !== 'object') throw new HttpError(400,'请填写经办复核记录。');
  const hasAudit = currentAudit(state,state.audit?.id);
  let submission;
  try { submission = makeSubmissionRecord(state,hasAudit ? state.audit : null,input,blobs.read); }
  catch (error) { throw new HttpError(400,error.message); }
  return reauditRecord(state,{submission},hasAudit);
}

async function saveCorrection(state,req) {
  if (state.policy !== policy || !state.preflight) throw new HttpError(409,'请先预检当前案卷。');
  const input = await readSmallJson(req);
  const hasAudit = currentAudit(state,state.audit?.id);
  if (input?.review === true && !hasAudit) throw new HttpError(409,'请先从当前案卷完成终件复验。');
  let corrections;
  try { corrections = makeCorrection(state,hasAudit ? state.audit.allowed : [],input); }
  catch (error) { throw new HttpError(400,error.message); }
  return reauditRecord(state,{corrections},hasAudit);
}

async function reauditRecord(state,patch,hasAudit) {
  const next = {...state,...patch,revision:state.revision+1,candidate:null,audit:null,stage:'preflight',lastError:null};
  next.inputStamp = inputStamp(next);
  if (!hasAudit) return persist(next);
  const {id,...previous} = state.candidate;
  const manifest = {...previous,inputStamp:next.inputStamp};
  return audit(persist({...next,candidate:{...manifest,id:stamp(manifest)},stage:'candidate'}));
}

function reportMarkdown(state) {
  const {audit,candidate} = state;
  return [
    '# 软著材料内部审阅包','',
    '成品质量 '+audit.quality+'%　正式提交准备度 '+audit.formal+'%','',
    '待确认当期办理要求、签认和权利来源。'+audit.externalStatus+'。','',
    '案卷 '+state.id+'　第 '+state.revision+' 版　审核 '+audit.id,'',
    ...audit.rows.map(row=>'- '+row.id+' '+row.title+'／'+row.status+'。'+row.evidence),
    ...audit.observations.map(item=>'- '+item.id+' '+item.path+'。'+item.detail),
    '', 'R2 三路版本证据及责任人见《版本核对.md》。',
    '', 'R3 主体、权属、签章出处及补件责任见《主体权属签章核对.md》。',
    '', '## 交付范围和原件读入', '',
    ...(audit.work.deliverables.length ? [
      audit.work.missingDeliverables.length ? '本次应交材料未齐。' : '本次应交材料均有经审核文件。',
      ...audit.work.deliverables.map(item=>'- '+item.title+'／'+item.status+'。'+
        (item.missing.length ? '缺：'+item.missing.join('、')+'。' : '')+
        item.files.map(file=>file.path+' '+file.sha256).join('、')),
    ] : ['本案未指定应交件，按实际收到和已审核材料列示。']),
    ...audit.work.readingGaps.map(gap=>'- '+gap.path+'。'+gap.detail),
    ...audit.work.sourceExclusions.map(item=>'- 自动选源排除 '+item.path+'。'+
      (item.kind==='third-party-copy' ? '原件注明为第三方副本。' : '已识别发布构建产物。')+'依据 '+item.evidence+'。'),
    '', '## R5 同版实操核对','',
    audit.runtimeEvidence.detail,
    '核对对象为产品或开发上传的记录及产物，执行环境和证据来源由经办人确认。',
    ...audit.runtimeEvidence.records.flatMap(record=>[
      '- '+record.path+'／'+record.status+'。'+record.detail,
      ...(record.versionProof ? ['  - 运行版本输出 '+record.versionProof.path+' '+record.versionProof.sha256] : []),
      ...record.steps.map(step=>'  - '+step.action+'／'+step.status+'。'+step.detail+
        (step.role ? '角色 '+step.role+'。前置 '+step.precondition+'。预期 '+step.expected+'。'+(step.mode === 'gui' ? 'GUI。' : '退出码 '+step.exitCode+'。') : '')+
        (step.proof ? '产物 '+step.proof.path+' '+step.proof.sha256+'。命中 '+step.proof.contains.join('、')+'。' : '')+
        (step.proof?.screenshot ? '截图 '+step.proof.screenshot.path+' '+step.proof.screenshot.sha256+'。' : '')+
        (step.locations?.length ? '终件 '+step.locations.map(hit=>hit.path+
          (hit.page ? ' 第 '+hit.page+' 页' : '')+' 第 '+hit.line+' 行').join('、')+'。' : '')),
    ]),
    '', '## 上传材料中的功能与出处','',
    ...(audit.featureCoverage ?? []).flatMap(manual=>manual.features.map(feature=>
      '- '+feature.name+'／'+(feature.complete ? '已读取操作和源码定位' : '步骤或源码待核')+'。'+
      manual.path+' 第 '+feature.heading.page+' 页第 '+feature.heading.line+' 行。'+
      feature.source.filter(Boolean).map(ref=>ref.path+':'+ref.line+' '+ref.sha256).join('、')+
      feature.steps.map(step=>'\n  - '+step.action+'／'+step.resultStatus+'。').join(''))),
    ...(audit.coverageMissing ?? []).map(hit=>'- 待核「'+hit.name+'」。表内出处 '+hit.path+' 第 '+hit.line+' 行。'),
    '', '## 自备说明书逐功能核对','',
    ...audit.selfReview.reviews.flatMap(manual=>[
      '- '+manual.path+'／'+manual.status+'。'+manual.detail,
      ...manual.features.flatMap(feature=>[
        '  - '+feature.name+'／'+feature.status+
          (feature.heading ? '，PDF 第 '+feature.heading.page+' 页第 '+feature.heading.line+' 行。' : '。'),
        ...feature.form.map(hit=>'    - 表 '+hit.path+' 第 '+hit.line+' 行 '+hit.sha256),
        ...feature.source.map(ref=>'    - 源码 '+(ref ? ref.path+' 第 '+ref.line+' 行 '+ref.sha256+' '+ref.anchor : '未对上清单定位')),
        ...feature.steps.map(step=>'    - '+(step ? step.role+'／'+step.precondition+'／'+step.action+
          '／'+step.expected+'。'+(step.runtime ? '输出 '+step.runtime.output.path+' '+step.runtime.output.sha256 :
            step.conflict ? '同版实际结果与正文不符。' :
            step.inManual ? '实际结果待补。' : '正文步骤待核。') : '步骤清单不完整。')),
      ]),
      ...(manual.extra ?? []).map(hit=>'  - 未列入清单的正文功能 '+hit.name+'，第 '+hit.page+' 页。'),
      ...(manual.extraForm ?? []).map(hit=>'  - 未列入清单的表内功能 '+hit.name+'，'+hit.path+' 第 '+hit.line+' 行。'),
    ]),
    '', '## 一般交存版式核对','',
    ...audit.layout.map(item=>{
      const affected = test => item.pages.filter(test).map(page=>page.number).join('、') || '无';
      return '- '+item.path+'｜实际读取 '+item.pages.length+' 页；正文门槛 '+item.minimum+
        ' 行；每页行数 '+item.pages.map(page=>page.lines).join('、')+'。'+item.scope+
        '\n  - 低于行数门槛：'+affected(page=>page.lines<item.minimum)+
        '。页码异常或不可读取：'+affected(page=>page.pageNumber!==page.number)+
        '。名称或版本未核对：'+affected(page=>!page.version || page.name!==true)+
        '。检测为非 A4：'+affected(page=>!page.a4)+'。';
    }),
    '', '## 待补与退回','',
    ...audit.actions.map(action=>'- '+action.id+' '+action.owner+'｜'+action.title+'。'+action.detail),
    '', '## 已落实的写回','',
    ...candidate.changes.map(change=>'- '+change.path+' '+change.loc+'\n  - '+change.before+' → '+change.after+'\n  - 依据 '+change.evidence),
    '', '## 已审核取件','', ...audit.allowed.map(file=>'- '+file.path+'　'+file.hash),
    '', '## 待核草稿','', ...audit.drafts.map(({file,reason})=>'- '+file.path+'　'+reason),
    '', '## 参考与待核原件','', ...audit.retained.map(file=>'- '+file.path+'　'+file.reason),
    '', '## 扫描识别文本','', ...audit.transcripts.map(file=>'- 识别文本/'+file.path+'。回对原件逐页校读。'),
    '', '## 同内容附件','', ...state.preflight.duplicates.map(file=>'- '+file.path+' 与 '+file.original+' 内容一致'),
  ].join('\n');
}

async function download(req,res,id,receipt,slot) {
  requireCurrentPolicy();
  const state = get(id);
  if (!currentAudit(state,receipt)) throw new HttpError(409,'审核回执已失效，请复验当前版本。');
  const {candidate,audit} = state;
  // Recompute both content-addressed manifests before reading any downloadable bytes.
  const {id:candidateId,...manifest} = candidate;
  if (candidateId !== stamp(manifest) || candidate.policy !== policy || candidate.inputStamp !== inputStamp(state) ||
      [...audit.allowed,...audit.drafts.map(item=>item.file)].some(file=>!candidate.files.some(item=>stamp(item) === stamp(file))) ||
      audit.transcripts.some(file=>!candidate.transcripts.some(item=>stamp(item) === stamp(file))) ||
      stamp(audit.replay) !== stamp(candidate.facts.launch?.length ?
        runtimeLaunch(state,candidate.facts.operations,blobs.read).replay : []) ||
      audit.retained.some(file=>!state.entries.some(item=>item.path === file.path &&
        item.hash === file.hash && item.size === file.size))) throw new HttpError(409,'终件清单无法与当前回执对应。');
  let bytes;
  let name;
  try {
    const checked = new Map([...audit.allowed,...audit.drafts.map(item=>item.file),...audit.retained,...audit.transcripts,...audit.replay]
      .map(file=>[file.hash,file]));
    for (const [hash,file] of checked) checked.set(hash,blobs.read(file));
    if (slot === 'submission') {
      bytes = Buffer.from(submissionReport(audit.submission));
      name = '提交准备度核对.md';
    } else if (slot !== undefined && slot !== 'bundle') {
      const file = audit.allowed[Number(slot)];
      if (!file) throw new HttpError(404,'此文件没有可取件的审核回执。');
      bytes = checked.get(file.hash);
      name = file.path.split('/').at(-1);
    } else {
      const zip = new JSZip();
      zip.file('审核报告.md',reportMarkdown(state));
      zip.file('审核回执.json',JSON.stringify(audit,null,2));
      zip.file('运行配置.json',JSON.stringify({policy,...configuration},null,2));
      zip.file('版本核对.md',versionReport(audit.versionCheck));
      zip.file('主体权属签章核对.md',applicationReport(audit.applicationCheck));
      zip.file('提交准备度核对.md',submissionReport(audit.submission));
      if (audit.corrections.length) zip.file('补正事项对照.md',correctionReport(audit.corrections));
      zip.file('输入清单.json',JSON.stringify({entries:state.entries,containers:state.containers,
        duplicates:state.preflight.duplicates,skipped:state.skipped,target:candidate.target,
        disposition:audit.disposition,deliverables:audit.work.deliverables},null,2));
      zip.file('逐处改动.json',JSON.stringify(candidate.changes,null,2));
      const delivered = [...audit.allowed,...audit.drafts.map(({file})=>file)];
      const generated = delivered.filter(file=>file.kind?.startsWith('filing-') || /^source-(pdf|docx)$/u.test(file.kind));
      if (generated.length) zip.file('材料生成与校核记录.json',JSON.stringify({
        receipt:audit.id,candidate:audit.candidateId,policy,
        process:'工作台读取此案原件、确认字段和同版证据，按程序规则编写底稿与说明书、排版交存件，并回读实际文件。',
        assets:generated.map(({path,kind,hash,from,evidence})=>({path,kind,sha256:hash,from,evidence,
          status:audit.allowed.some(item=>item.path === path) ? '经审核材料' : '待核草稿'})),
        operations:candidate.facts.operations.map(({record,version,versionProof,proof})=>({record,version,versionProof,proof})),
        scope:candidate.sourceMap?.runtime_resource_scope ?? null,
        edits:'同包逐处改动.json 记录工作副本的实际写回。',
        applicant:'经办核准及适用声明以同包提交准备度核对为准。',
      },null,2));
      if (candidate.sourceMap && [...audit.allowed,...audit.drafts.map(item=>item.file)]
        .some(file=>['source-pdf','source-docx','uploaded-source-pdf'].includes(file.kind))) {
        zip.file('源码行号映射.json',JSON.stringify(candidate.sourceMap,null,2));
      }
      for (const item of audit.allowed) zip.file('经审核材料/'+item.path,checked.get(item.hash));
      for (const {file} of audit.drafts) zip.file('待核草稿/'+file.path,checked.get(file.hash));
      for (const item of audit.replay) zip.file(item.path,checked.get(item.hash));
      for (const item of audit.retained) zip.file(item.bundlePath,checked.get(item.hash));
      for (const item of audit.transcripts) zip.file('识别文本/'+item.path,checked.get(item.hash));
      bytes = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
      name = '软著材料－内部审阅包.zip';
    }
  } catch (error) {
    if (error.status) throw error;
    throw new HttpError(409,'终件无法读出或指纹不符，请恢复后复验。');
  }
  requireCurrentPolicy();
  if (!currentAudit(get(id),receipt)) throw new HttpError(409,'取件期间案卷发生变更，请重新复验。');
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,
    'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16))});
  res.end(bytes);
}

async function mutation(res,state,action,task) {
  if (active.has(state.id)) throw new HttpError(409,'案卷正在处理，请等当前操作结束。');
  active.set(state.id,action);
  try { await task(); }
  catch (error) {
    if (error.status) throw error;
    const latest = get(state.id);
    persist({...latest,lastError:'本阶段未完成 '+action});
    throw error;
  } finally { active.delete(state.id); }
  json(res,200,visible(get(state.id)));
}

async function handler(req,res) {
  const url = new URL(req.url,origin);
  if (req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin)) throw new HttpError(403,'仅允许本机案卷入口。');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  if (req.method === 'GET' && url.pathname === '/') {
    requireCurrentPolicy();
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(ui); return;
  }
  if (req.method === 'GET' && url.pathname === '/intake-paths.mjs') {
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'}); res.end(intakePaths); return;
  }
  if (req.method === 'GET' && url.pathname === '/worker') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end('<!doctype html><title>文档读取</title>'); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cases') {
    requireCurrentPolicy();
    const {uploads,request} = await readUpload(req);
    const {entries,containers,skipped} = await expandUploads(uploads,blobs);
    const state = reset({id:randomUUID()},{entries,containers,skipped,request,target:null});
    try { await preflight(state); }
    catch (error) {
      console.error(error);
      persist({...state,lastError:'本阶段未完成 预检'});
    }
    json(res,200,visible(get(state.id)));
    return;
  }
  const match = url.pathname.match(/^\/api\/cases\/([a-f\d-]{36})(?:\/([a-z-]+))?(?:\/([a-f\d]{64})(?:\/(bundle|submission|\d+))?)?$/);
  if (!match) throw new HttpError(404,'找不到请求的入口。');
  const [,id,action,receipt,slot] = match;
  const state = get(id);
  if (req.method === 'GET' && !action) { requireCurrentPolicy(); json(res,200,visible(state)); return; }
  if (req.method === 'GET' && action === 'download' && receipt) { await download(req,res,id,receipt,slot); return; }
  if (req.method !== 'POST' || receipt) throw new HttpError(404,'找不到请求的入口。');
  requireCurrentPolicy();
  if (req.headers['x-case-revision'] !== String(state.revision)) throw new HttpError(409,'案卷版本已更新，请刷新再操作。');
  const edit = async () => {
    if (action === 'submission') return saveSubmission(state,req);
    if (action === 'correction') return saveCorrection(state,req);
    if (action === 'intake') {
      const {uploads} = await readUpload(req);
      const update = await expandUploads(uploads,blobs);
      const byPath = new Map(state.entries.map(file=>[file.path,file]));
      for (const file of update.entries) {
        byPath.set(file.path,file);
      }
      const entries = [...byPath.values()];
      if (entries.length > maxFiles || entries.reduce((sum,file)=>sum+file.size,0)>maxBytes) throw new HttpError(400,'案卷最多保留 '+maxFiles+' 件、48 MiB 有效材料。');
      return preflight(reset(state,{entries,submission:invalidateSubmission(state,entries),
        containers:[...state.containers,...update.containers],skipped:[...state.skipped,...update.skipped]}));
    }
    if (action === 'withdraw') {
      const path = url.searchParams.get('path');
      const entries = state.entries.filter(file=>file.path!==path);
      if (!path || entries.length === state.entries.length || !entries.length) throw new HttpError(400,'请保留至少一份当前案卷材料。');
      return preflight(reset(state,{entries,submission:invalidateSubmission(state,entries)}));
    }
    if (action === 'request') {
      const input = await readSmallJson(req);
      if (typeof input?.request !== 'string') throw new HttpError(400,'请填写本案说明。');
      const request = input.request.trim();
      if (request.length > 2000) throw new HttpError(400,'本案说明最多 2000 字。');
      if (request === state.request) return state;
      return preflight(reset(state,{request,materialSelection:null,priorWork:state.preflight?.work,
        submission:invalidateSubmission(state,state.entries,state.target,true)}));
    }
    if (action === 'target') {
      const version = url.searchParams.get('version')?.trim().match(/^v?(\d+(?:\.\d+){1,3})$/i)?.[1];
      const snapshot = url.searchParams.get('snapshot') || undefined;
      const softwareNameParam = url.searchParams.get('softwareName');
      const softwareName = softwareNameParam === null ? state.softwareName :
        softwareNameParam.trim() || undefined;
      const scope = url.searchParams.get('scope');
      const materialSelection = scope === null ? state.materialSelection :
        scope === 'auto' ? null : scope.split(',').filter(Boolean);
      if ((url.searchParams.get('version')?.trim() && !version) ||
          (snapshot && (!version || snapshot !== state.preflight?.choice?.snapshot))) {
        throw new HttpError(400,'版本应为数字版本号。源码快照须来自已识别的版本。');
      }
      if (softwareName && (softwareName.length > 100 || /[\u0000-\u001f\u007f]/u.test(softwareName))) {
        throw new HttpError(400,'请填写有效的软件全称（最多 100 字）。');
      }
      if (materialSelection?.some(key=>!Object.hasOwn(materialTitles,key))) throw new HttpError(400,'请选择可用的应交材料。');
      const target = url.searchParams.has('version') ?
        version ? {version:'V'+version,snapshot,confirmedAt:new Date().toISOString()} : null : state.target;
      return preflight(reset(state,{target,softwareName,materialSelection,
        ...(stamp(materialSelection ?? null) !== stamp(state.materialSelection ?? null) && {priorWork:state.preflight?.work}),
        submission:invalidateSubmission(state,state.entries,target,
          softwareName !== state.softwareName || stamp(materialSelection ?? null) !== stamp(state.materialSelection ?? null))}));
    }
    if (action === 'preflight') return preflight(reset(state,{}));
    if (action === 'process') {
      const previous = state.policy === policy && state.preflight?.work && packagedWebProofCurrent(state,blobs.read) ?
        state : await preflight(reset(state,{}));
      if (previous.preflight.work.needsConfirmation) throw new HttpError(409,'请先确认要交付的材料。');
      if (previous.stage === 'audited') persist({...previous,stage:'preflight',candidate:null,audit:null});
      return audit(await prepare(get(id)));
    }
    if (action === 'audit' && state.candidate?.policy === policy && state.candidate?.inputStamp === state.inputStamp &&
        packagedWebProofCurrent(state,blobs.read)) return audit(state);
    throw new HttpError(409,'请从当前案卷预检或运行复验。');
  };
  await mutation(res,state,action,edit);
}

const server = createServer((req,res)=>handler(req,res).catch(error=>{
  const expected = error.status || /ZIP|zip|解包|附件|材料|上传|案卷|路径/.test(error.message);
  if (!expected) console.error(error);
  if (!res.headersSent) json(res,error.status || (expected ? 400 : 500),{error:expected ? error.message : '服务未完成本阶段，请检查本机运行日志。'});
  else res.destroy();
}));
server.listen(Number(process.env.SOFTCERT_PORT ?? 8793),'127.0.0.1',()=>{
  origin = 'http://127.0.0.1:'+server.address().port;
  console.log(origin);
});
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,async ()=>{
  await closeWorker();
  server.close(()=>{db.close();process.exit(0);});
});
