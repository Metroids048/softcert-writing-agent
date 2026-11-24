import { stamp } from './files.mjs';

const list = [
  ['channel','适用办理通道','经办人','核对当前受理入口、适用情形和有效要求，归档依据。'],
  ['form','当期申请表','申请人','核对通道提供的当期表单、软件版本及实际申请人。'],
  ['deposit','本版交存与操作证据','开发方 / 文档整理人','核对拟交存的程序、文档、同版操作证据和当前通道格式。'],
  ['identity','实际申请人和主体证件','申请人','逐一核对申请人与有效证件的对应关系。'],
  ['rights','权属依据','申请人 / 相关权利方','核对原件、权利链、软件版本及许可或自行开发范围。'],
  ['declaration','来源与其他声明','申请人','核对适用声明的原件、软件版本、主体及已确认的内容。'],
  ['signature','签章','申请人','目验当期签认原件的签名或盖章、权限及完整页。'],
  ['other','通道要求的其他材料','经办人','核清本案其他要求。无适用项目时，记录通道依据与理由。'],
];
const visual = /\.(?:pdf|docx|png|jpe?g|webp|tiff?|heic)$/iu;
const channelFile = /办理|通道|登记指南|受理须知|业务须知|申报指南|官方要求|办理指南/u;
const declarationFile = /声明|承诺|情况说明|来源说明/u;
const fields = ['path','hash'];
const originals = refs => refs.map(file=>({path:file.path,hash:file.hash ?? file.sha256}));
const human = value => typeof value === 'string' ? value.trim() : '';
const reasonable = (value,min,max) => value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const eligible = (proof,choices) => proof.length && proof.every(file=>
  choices.some(choice=>fields.every(key=>file[key] === choice[key])));

function depositOptions(audit) {
  const allowed = audit?.allowed ?? [];
  const volumes = audit?.sourceVolumes?.length ? audit.sourceVolumes : ['all'];
  const generated = allowed.filter(file=>file.kind === 'source-pdf');
  const uploaded = (audit?.verifiedSources ?? []).filter(item=>allowed.some(file=>
    file.kind === 'uploaded-source-pdf' && file.path === item.path && file.hash === item.sha256))
    .map(item=>({...item,hash:item.sha256}));
  const manuals = allowed.filter(file=>file.kind === 'filing-manual' ||
    file.kind === 'uploaded-manual-pdf' && audit.verifiedManuals?.some(item=>
      item.path === file.path && item.sha256 === file.hash && item.status === '逐项结果已对照'));
  const groups = [generated,uploaded].filter(set=>set.length === volumes.length && volumes.every(volume=>
    set.filter(file=>(file.volume ?? 'all') === volume).length === 1));
  return groups.flatMap(set=>manuals.map(manual=>originals([...set,manual])));
}

export function submissionReadiness(state, audit = null) {
  const check = state.preflight?.applicationCheck;
  if (!check) return null;
  const report = state.preflight.report;
  const prior = state.submission ?? {};
  const r3 = Object.fromEntries(check.items.map(item=>[item.id,item]));
  const applicantRecords = r3.identity.evidence.filter(hit=>hit.field==='申请人');
  const applicants = [...new Set(applicantRecords.map(hit=>hit.value))];
  const version = state.target?.version ?? state.preflight.versionCheck.reference ?? null;
  const software = state.softwareName ?? state.preflight.choice?.softwareName ??
    state.preflight.versionCheck.groups.release.find(item=>item.name)?.name ?? null;
  const snapshot = state.target?.snapshot ?? null;
  const subjectScope = stamp({applicants, forms:originals(applicantRecords),version,snapshot,software});
  const current = new Set(state.entries.map(file=>file.path+'\0'+file.hash));
  const references = new Set(check.references.map(hit=>hit.path));
  const usable = report.files.filter(file=>!file.unreadable && !file.blank && !file.truncated &&
    !file.ocr?.unresolved.length && !references.has(file.path) && current.has(file.path+'\0'+file.hash));
  const channelChoices = usable.filter(file=>['other','form'].includes(file.role) && channelFile.test(file.path));
  const scopeMatches = (previous,scope,choices) => !previous?.invalidated &&
    previous?.scope === scope && eligible(previous.evidence,choices);
  const channelScope = stamp({version,snapshot,software,applicants,forms:originals(applicantRecords)});
  const channel = scopeMatches(prior.channel,channelScope,channelChoices) ? prior.channel : null;
  const depositSets = depositOptions(audit);
  const deposit = [...new Map(depositSets.flat().map(file=>[file.path,file])).values()];
  const choicesById = {
    channel:channelChoices,
    form:usable.filter(file=>applicantRecords.some(hit=>hit.path===file.path && hit.sha256===file.hash)),
    identity:usable.filter(file=>r3.identity.attachments.some(hit=>hit.path===file.path && hit.sha256===file.hash)),
    rights:usable.filter(file=>r3.rights.attachments.some(hit=>hit.path===file.path && hit.sha256===file.hash)),
    signature:usable.filter(file=>visual.test(file.path) &&
      r3.signature.attachments.some(hit=>hit.path===file.path && hit.sha256===file.hash)),
    declaration:usable.filter(file=>['declaration','other'].includes(file.role) && declarationFile.test(file.path)),
    other:usable.filter(file=>!['source','manual','form','identity','rights','declaration'].includes(file.role)),
    deposit,
  };
  const items = list.map(([id,title,owner,next])=>{
    const choices = originals(choicesById[id]);
    const r3Status = r3[id]?.status;
    const missing = !choices.length || id !== 'channel' &&
      (!channel || !applicants.length || !version || r3Status === 'missing') ||
      id === 'deposit' && (!depositSets.length || audit.runtimeEvidence.status !== '部分已对照');
    const conflict = r3Status === 'conflict' || (id !== 'channel' && r3.identity.status === 'conflict');
    const scope = id === 'channel' ? channelScope : stamp({subjectScope,channel,
      deposit:id === 'deposit' ? depositSets : undefined});
    const record = conflict || missing ? null : scopeMatches(prior[id],scope,choices) ? prior[id] : null;
    const status = conflict ? '发现冲突' : record ? record.outcome : prior[id] ? '原复核失效' :
      missing ? (id === 'other' ? '适用性待核' : '待补') : '待经办复核';
    return {id,title,owner,next,choices,scope,status,record,reviewable:!conflict && !missing,
      ...(id === 'deposit' && {sets:depositSets})};
  });
  const ready = !!audit && !audit.versionConflict && !audit.criticalIssues &&
    items.every(item=>!!item.record && (item.id==='other' || item.record.outcome==='已复核'));
  return {software,version,snapshot,applicants,channel:channel?.channel ?? null,items,ready,
    reviewed:items.filter(item=>item.record).length};
}

export function invalidateSubmission(state, entries, target = state.target, intakeChanged = false) {
  if (!state.submission) return undefined;
  const before = new Map(state.entries.map(file=>[file.path,file.hash]));
  const after = new Map(entries.map(file=>[file.path,file.hash]));
  const changed = [...before].some(([path,hash])=>after.get(path)!==hash &&
    state.preflight?.report.files.some(file=>file.path===path && ['form','source'].includes(file.role)));
  const versionChanged = target?.version!==state.target?.version || target?.snapshot!==state.target?.snapshot;
  const lost = record=>record.evidence.some(file=>before.get(file.path)===file.hash && after.get(file.path)!==file.hash);
  const lostChannel = state.submission.channel && lost(state.submission.channel);
  return Object.fromEntries(Object.entries(state.submission).map(([id,record])=>
    [id,changed || versionChanged || intakeChanged || lostChannel || lost(record) ? {...record,invalidated:true} : record]));
}

export function makeSubmissionRecord(state, audit, input, read) {
  const plan = submissionReadiness(state,audit);
  const item = plan?.items.find(item=>item.id===input.id);
  if (!item?.reviewable) throw new Error('本案卷该项缺当前依赖、适用材料或仍有冲突。');
  const responsible = human(input.responsible);
  const reviewer = human(input.reviewer);
  const basis = human(input.basis);
  const channel = item.id === 'channel' ? human(input.channel) : undefined;
  const outcome = input.notApplicable && item.id === 'other' ? '不适用' : '已复核';
  const paths = Array.isArray(input.paths) ? [...new Set(input.paths)] : [];
  const evidence = item.choices.filter(file=>paths.includes(file.path));
  if (!reasonable(responsible,2,80) || !reasonable(reviewer,2,80) || !reasonable(basis,8,500) ||
      item.id === 'channel' && !reasonable(channel,3,120) || input.confirmed !== true ||
      !paths.length || paths.length > 20 || evidence.length !== paths.length) {
    throw new Error('请填写材料责任人、经办人和具体核对依据，并选择本案卷当前附件和确认目验。');
  }
  if (item.id === 'deposit' && !item.sets.some(set=>set.length === evidence.length && eligible(evidence,set))) {
    throw new Error('请选择一整套当前交存源码（同一套全部卷）及一份已通过同版核对的说明书。');
  }
  if (item.id === 'identity') {
    const normalize = value=>value.normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
    const facts = state.preflight.applicationCheck.items.find(row=>row.id==='identity').evidence;
    if (!plan.applicants.every(name=>facts.some(hit=>['姓名','名称'].includes(hit.field) &&
        normalize(name)===normalize(hit.value) && evidence.some(file=>file.path===hit.path && file.hash===hit.sha256)))) {
      throw new Error('请选择本案卷每一位实际申请人的对应证件。');
    }
  }
  if (outcome === '不适用' && !evidence.some(file=>state.submission.channel.evidence.some(ref=>
    ref.path===file.path && ref.hash===file.hash))) {
    throw new Error('请选用本案卷已核对的办理通道依据说明不适用。');
  }
  for (const ref of evidence) {
    const file = (item.id === 'deposit' ? audit.allowed : state.entries).find(file=>
      file.path===ref.path && file.hash===ref.hash);
    if (!file) throw new Error('案卷附件已变，请重新核对。');
    read(file);
  }
  return {...state.submission,[item.id]:{scope:item.scope,outcome,evidence,responsible,reviewer,basis,channel,
    checkedAt:new Date().toISOString()}};
}

export function submissionReport(plan) {
  return ['# 提交准备度核对','',
    '软件 '+(plan.software ?? '待核')+' · 版本 '+(plan.version ?? '待核')+
      (plan.snapshot ? ' · 源码快照 '+plan.snapshot : ''),
    '实际申请人 '+(plan.applicants.join('、') || '待补'),
    '办理通道 '+(plan.channel ?? '待核'),
    '经办记录 '+plan.reviewed+'／'+plan.items.length+' · '+(plan.ready ? '经办记录齐备' : '提交准备仍有缺项'),
    '外部办理按真实机构回执另行记录。','',
    ...plan.items.flatMap(item=>[
      '## '+item.title+' · '+item.status,'',
      '责任 '+(item.record?.responsible ?? item.owner),
      ...(item.record ? ['经办人 '+item.record.reviewer+' · '+item.record.checkedAt,
        '核对依据 '+item.record.basis,...item.record.evidence.map(file=>'- '+file.path+' · SHA-256 '+file.hash)] :
        [item.next,...item.choices.map(file=>'- 待核 '+file.path+' · SHA-256 '+file.hash)]),'',
    ]),
  ].join('\n');
}
