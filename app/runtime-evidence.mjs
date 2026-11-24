// This reader only opens uploaded records and their artifacts. It never runs submitted commands.
export const isRuntimeEvidence = path => path.startsWith('实操证据/');
const isRecord = path => isRuntimeEvidence(path) && path.endsWith('.softcert-run.json');
const isHash = value => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const text = (value, max = 300) => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const name = value => value?.normalize('NFKC').trim().toLowerCase();
const version = value => /^v?(\d+(?:\.\d+){1,3})$/i.exec(value ?? '')?.[1];
export function normalizedVersion(value) {
  const number = typeof value === 'string' && version(value.trim());
  return number ? 'V'+number : null;
}
const normalized = value => value.normalize('NFC').replace(/\s+/gu,' ').trim();
const compact = value => value.normalize('NFKC').replace(/[\s`]/gu,'');
const decoder = new TextDecoder('utf-8',{fatal:true});

function locateAction(manuals, details, action) {
  const command = normalized(action);
  return manuals.flatMap(file=>{
    const pages = details.get(file.path)?.pages ?? [];
    return pages.flatMap((page,index)=>page.lines.flatMap((value,line)=>{
        const clean = normalized(value);
        let wrapped = compact(clean);
        const labelled = wrapped.startsWith('操作:');
        const target = '操作:'+compact(action);
        for (let next = line+1; labelled && wrapped !== target && target.startsWith(wrapped) &&
            next < page.lines.length; next++) wrapped += compact(page.lines[next]);
        const found = clean.includes('`'+command+'`') ||
          clean.replace(/^(?:操作\s*[:：]\s*|[-*]\s+|\$\s+)/u,'').trim() === command ||
          clean.split('〔')[0].split('|').at(-1).replace(/^(?:[-*]\s+|\$\s+)/u,'').trim() === command ||
          labelled && wrapped === target;
        return found ? [{path:file.path,sha256:file.hash,line:line+1,
          ...(/\.pdf$/i.test(file.path) && {page:index+1})}] : [];
    }));
  });
}

function artifactBytes(ref, inputs, read, limit) {
  if (!text(ref?.path,480) || !isRuntimeEvidence(ref.path) || isRecord(ref.path) || !isHash(ref.sha256)) return;
  const file = inputs.get(ref.path);
  if (file?.hash !== ref.sha256 || file.size > limit) return;
  return read(file);
}

function readArtifact(ref, inputs, read) {
  const bytes = artifactBytes(ref,inputs,read,1024*1024);
  try { return bytes && decoder.decode(bytes); }
  catch { return; }
}

function guiScreenshot(ref, inputs, read) {
  const bytes = artifactBytes(ref,inputs,read,5*1024*1024);
  if (!bytes) return;
  const png = bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a' &&
    bytes.subarray(12,16).toString('ascii') === 'IHDR';
  const jpeg = bytes.subarray(0,3).toString('hex') === 'ffd8ff' &&
    bytes.subarray(-2).toString('hex') === 'ffd9';
  if (png && /\.png$/iu.test(ref.path) || jpeg && /\.jpe?g$/iu.test(ref.path)) {
    return {path:ref.path,sha256:ref.sha256};
  }
}

function reviewStep(step, inputs, read, manuals, details) {
  const {role,precondition,action,expected,exitCode,proof,mode='command'} = step ?? {};
  const item = {action:text(action) ? action : '未提供可核的动作'};
  if (![role,precondition,action,expected].every(value=>text(value)) ||
      !['command','gui'].includes(mode) || mode === 'command' && !Number.isInteger(exitCode) ||
      !Array.isArray(proof?.contains) ||
      !proof.contains.length || proof.contains.length > 8 || !proof.contains.every(value=>text(value,160))) {
    return {...item,status:'记录不完整',detail:'请提供操作角色、前置条件、完整动作、预期结果、输出检查文本，以及命令退出码或 GUI 截图。'};
  }
  const locations = manuals ? locateAction(manuals,details,action) : [];
  const row = {role,precondition,action,expected,locations,mode,...(mode === 'command' && {exitCode})};
  const actual = readArtifact(proof,inputs,read);
  const screenshot = mode === 'gui' ? guiScreenshot(proof.screenshot,inputs,read) : null;
  const outcomeMatches = mode === 'gui' ? screenshot && actual?.split(/\r?\n/u).some(line=>normalized(line) === normalized(expected)) : exitCode === 0;
  if (actual === undefined || !outcomeMatches || !proof.contains.every(value=>actual.includes(value))) {
    return {...row,status:'运行产物不符',detail:'请核对运行产物的文件指纹、预期内容和命令退出码或 GUI 截图。'};
  }
  if (manuals && !locations.length) return {...row,status:'终件找不到动作',detail:'请把准确的命令或动作写入交付的说明书后复验。'};
  return {...row,status:'已对照',proof:{path:proof.path,sha256:proof.sha256,contains:proof.contains,...(screenshot && {screenshot})},
    detail: !manuals ? '已对照上传的结果及凭证文件指纹，等待起草和终件核对。' :
      mode === 'gui' ? '已定位终件动作并对照上传的结果文本和截图文件指纹。截图画面及录制环境由经办人核看。' :
      '已在取件说明书定位动作，上传的输出文件含所列结果。'};
}

function readRecord(file, read) {
  let record;
  try {
    if (file.size <= 64*1024) record = JSON.parse(decoder.decode(read(file)));
  } catch { /* Report an unreadable record without stopping the material audit. */ }
  if (record?.schema !== 'softcert-runtime/v1' || !text(record.softwareName) ||
      !text(record.version,32) || !version(record.version) || !isHash(record.archiveSha256)) return;
  return record;
}

function readVersionProbe(record, inputs, read) {
  const proof = record.versionProbe;
  if (proof?.kind === 'git-archive-commit') {
    const commit = readArtifact(proof,inputs,read)?.trim();
    return {commitProbe:true,...(/^[a-f\d]{40}$/u.test(commit ?? '') &&
      {reportedCommit:commit,versionProof:{path:proof.path,sha256:proof.sha256}})};
  }
  const reportedVersion = normalizedVersion(readArtifact(proof,inputs,read));
  return reportedVersion ? {reportedVersion,versionProof:{path:proof.path,sha256:proof.sha256}} : {};
}

export function runtimeVersionInputs(entries, read) {
  const inputs = new Map(entries.map(file=>[file.path,file]));
  return entries.filter(file=>isRecord(file.path)).map(file=>{
    const record = readRecord(file,read);
    const source = {path:file.path,sha256:file.hash};
    if (!record) return source;
    return {...source,softwareName:record.softwareName,declaredVersion:normalizedVersion(record.version),
      archiveSha256:record.archiveSha256,...readVersionProbe(record,inputs,read)};
  });
}

export function browserResourceProofs(entries, read, target) {
  const inputs = new Map(entries.map(file=>[file.path,file]));
  return entries.filter(file=>isRecord(file.path)).flatMap(file=>{
    const record = readRecord(file,read);
    const probe = record && readVersionProbe(record,inputs,read);
    if (!record || record.archiveSha256 !== target.archiveSha256 ||
        !target.names.some(value=>name(value) === name(record.softwareName)) ||
        normalizedVersion(record.version) !== normalizedVersion(target.version) ||
        (target.commit ? probe.reportedCommit !== target.commit : probe.reportedVersion !== normalizedVersion(target.version)) ||
        !Array.isArray(record.steps) || record.steps.length > 24 ||
        !record.steps.some(step=>step?.mode === 'gui' && reviewStep(step,inputs,read).status === '已对照') ||
        !Array.isArray(record.extraProof) || record.extraProof.length > 24) return [];
    return record.extraProof.flatMap(ref=>{
      try {
        const bytes = artifactBytes(ref,inputs,read,5*1024*1024);
        const responseLog = bytes && JSON.parse(decoder.decode(bytes));
        const served = responseLog?.served;
        if (served && typeof served === 'object' && !Array.isArray(served) &&
            Object.entries(served).every(([path,hash])=>path.startsWith('/') && isHash(hash))) {
          return [{path:ref.path,sha256:ref.sha256,served,recordPath:file.path,recordSha256:file.hash,
            browser:typeof responseLog.browser === 'string' && /^\d+(?:\.\d+){1,4}$/u.test(responseLog.browser) ?
              responseLog.browser : null}];
        }
      } catch { /* Other supplemental evidence need not be a browser resource log. */ }
      return [];
    });
  });
}

function reviewRecord(file, state, inputs, read, manuals, details) {
  const outcome = (status, detail, extra = {}) => ({path:file.path,sha256:file.hash,status,detail,steps:[],...extra});
  const record = readRecord(file,read);
  if (!record || !Array.isArray(record.steps) || !record.steps.length || record.steps.length > 24) {
    return outcome('记录不完整','请补符合同版实操记录格式的文件。每份记录应有 1 至 24 个步骤。');
  }
  const {candidate,containers} = state;
  const source = candidate.sourceMap ?? candidate.sourceBasis;
  const versionFinding = candidate.versionCheck?.probes.find(item=>item.path === file.path && item.sha256 === file.hash);
  if (candidate.conflict && versionFinding?.bound && versionFinding.reportedCommit &&
      (versionFinding.reportedCommit !== versionFinding.confirmedCommit || versionFinding.declaredVersion !== versionFinding.confirmedVersion)) {
    const {reportedCommit,confirmedCommit,confirmedVersion,versionProof,archiveSha256} = versionFinding;
    return outcome('版本显示待核','实际运行提交或声明版次与本案确认记录不符。',{
      expectedVersion:confirmedVersion,reportedCommit,confirmedCommit,versionProof,archiveSha256});
  }
  if (candidate.conflict && versionFinding?.bound && versionFinding.reportedVersion && versionFinding.releaseVersion &&
      versionFinding.reportedVersion !== versionFinding.releaseVersion) {
    const {releaseVersion,reportedVersion,versionProof,archiveSha256} = versionFinding;
    return outcome('版本显示待核','发布材料为 '+releaseVersion+'，程序实际显示 '+reportedVersion+
      '。起草前已暂缓，说明书动作待版本核实后复验。',{expectedVersion:releaseVersion,reportedVersion,versionProof,archiveSha256});
  }
  if (candidate.conflict || !source?.files?.length || !version(candidate.target?.version)) {
    return outcome('缺冻结版本','请先确认目标软件版本并补可追溯的同版源码。');
  }
  if (![source.software_name,source.package_name].filter(Boolean).some(value=>name(record.softwareName) === name(value)) ||
      version(record.version) !== version(candidate.target.version) ||
      version(record.version) !== version(source.version)) {
    return outcome('名称或版本不符','记录为 '+record.softwareName+' '+record.version+'，本案固定为 '+
      source.software_name+' '+candidate.target.version+'。请补本次版本的操作记录。');
  }
  const archive = containers.find(item=>item.hash === record.archiveSha256);
  if (!archive || !source.files.every(item=>{
    const input = inputs.get(item.path);
    if (input?.hash === item.sha256 && input.container?.hash === archive.hash) return true;
    const supplement = state.preflight?.packaged?.web?.supplements.find(row=>
      row.path === item.path && row.hash === item.sha256 && row.archiveSha256 === archive.hash);
    if (!input && supplement) {
      read(supplement);
      return true;
    }
    return false;
  })) return outcome('源码不符','运行记录所指的源码 ZIP 与本案冻结的源码文件不一致。');
  read(archive);
  if (record.extraProof !== undefined && (!Array.isArray(record.extraProof) || record.extraProof.length > 24 ||
      !record.extraProof.every(ref=>artifactBytes(ref,inputs,read,5*1024*1024)))) {
    return outcome('运行产物不符','实操补充凭证缺失或文件指纹不符。请核对所列实际下载物及截图。');
  }

  const steps = record.steps.map(step=>reviewStep(step,inputs,read,manuals,details));
  const output = readVersionProbe(record,inputs,read);
  const extra = {steps,archiveSha256:archive.hash,expectedVersion:candidate.target.version,
    ...(record.extraProof?.length && {support:record.extraProof.map(({path,sha256})=>({path,sha256}))}),
    ...output};
  if (output.commitProbe && !(versionFinding?.bound && versionFinding.confirmedCommit &&
      output.reportedCommit === versionFinding.confirmedCommit &&
      (versionFinding.staticArchive || candidate.target.snapshot === versionFinding.confirmedCommit) &&
      versionFinding.declaredVersion === versionFinding.confirmedVersion)) {
    return outcome('缺运行版本输出','请补能绑定本案确认快照的实际运行提交及文件指纹。',extra);
  }
  if (!output.commitProbe && !output.reportedVersion) return outcome('缺运行版本输出','请补实际程序的版本命令输出及文件指纹。',extra);
  if (!output.commitProbe && output.reportedVersion !== normalizedVersion(record.version)) return outcome('版本显示待核',
    '固定源码版本 '+candidate.target.version+'，实际程序显示 '+output.reportedVersion+'。请开发方核对程序版本标记。',extra);
  if (steps.some(step=>step.status==='已对照')) return outcome('部分已对照','请继续补齐其余核心功能的同版实操。',extra);
  return outcome('步骤待补','版本已对应。请修正下列动作或补实际输出。',extra);
}

export function reviewRuntimeEvidence(state, read, manuals, details) {
  const inputs = new Map(state.entries.map(file=>[file.path,file]));
  const records = state.entries.filter(file=>isRecord(file.path))
    .map(file=>reviewRecord(file,state,inputs,read,manuals,details));
  const matched = new Set(records.filter(record=>record.status==='部分已对照')
    .flatMap(record=>record.steps.filter(step=>step.status==='已对照').map(step=>step.action))).size;
  const versionConflict = records.some(record=>record.status==='版本显示待核');
  const status = !versionConflict && records.some(record=>record.status==='部分已对照') ? '部分已对照' : '待补';
  const detail = records.length ?
    '已对照 '+matched+' 个独立动作。请核看版本显示、证据来源及未覆盖的核心功能。' :
    '缺少同版实操记录。请由产品或开发按说明书实际操作，上传版本输出和各步骤的结果。';
  return {status,detail,matched,versionConflict,records};
}

// This handoff contains only claims supported by the uploaded probe and results.
export function operationFacts(runtime) {
  const operations = new Map();
  if (runtime.versionConflict) return [];
  for (const record of runtime.records.filter(item=>item.status === '部分已对照')) {
    for (const step of record.steps.filter(item=>item.status === '已对照')) {
      const key = JSON.stringify([step.role,step.precondition,step.action,step.mode]);
      const rows = operations.get(key) ?? [];
      const {role,precondition,action,expected,mode,proof} = step;
      const results = mode === 'gui' ? [expected] : proof.contains;
      rows.push({role,precondition,action,mode,results,version:record.reportedVersion ?? record.expectedVersion,
        ...(record.reportedCommit && {commit:record.reportedCommit}),
        record:{path:record.path,sha256:record.sha256},proof,versionProof:record.versionProof});
      operations.set(key,rows);
    }
  }
  return [...operations.values()].flatMap(rows=>rows.every(row=>
    JSON.stringify(row.results) === JSON.stringify(rows[0].results)) ? [rows[0]] : []);
}

export function runtimeLaunch(state, operations, read) {
  const packaged = state.preflight?.packaged;
  if (!operations.length) return {launch:[],replay:[]};
  if (packaged?.web?.launch.length) return {launch:packaged.web.launch,replay:packaged.web.replay};
  const distribution = packaged?.pythonDistribution;
  const source = state.candidate?.sourceMap ?? state.candidate?.sourceBasis;
  if (!distribution || !source?.files.length) return {launch:[],replay:[]};
  const [first] = operations;
  const [command, interpreter, module] = /^(python3?) -m ([A-Za-z]\w*(?:\.[A-Za-z]\w*)*)\s/u.exec(first.action) ?? [];
  if (!module || !operations.every(item=>item.mode === 'command' && item.action.startsWith(command) &&
      item.record.sha256 === first.record.sha256)) return {launch:[],replay:[]};
  const modulePath = module.replaceAll('.','/');
  const entry = [modulePath+'/__main__.py',modulePath+'.py']
    .find(path=>source.files.some(item=>item.path === distribution.prefix+path));
  const archive = state.containers.find(item=>item.hash === distribution.archiveSha256);
  if (!entry || !archive) return {launch:[],replay:[]};
  const inputs = new Map(state.entries.map(file=>[file.path,file]));
  const recordFile = inputs.get(first.record.path);
  const record = recordFile?.hash === first.record.sha256 && readRecord(recordFile,read);
  if (!record || record.archiveSha256 !== archive.hash) return {launch:[],replay:[]};
  const findOutput = (steps,option) => {
    const hit = steps.find(step=>step?.exitCode === 0 && Array.isArray(step.argv) &&
      step.argv.length === 4 && step.argv[0] === interpreter && step.argv[1] === '-m' &&
      step.argv[2] === module && step.argv[3] === option);
    return hit && readArtifact(hit.stdout,inputs,read)?.trim();
  };
  for (const ref of record.extraProof ?? []) {
    let log;
    try { log = JSON.parse(readArtifact(ref,inputs,read)); } catch { continue; }
    if (!Array.isArray(log?.steps) || log.steps.length > 48) continue;
    const output = findOutput(log.steps,'--version');
    const help = findOutput(log.steps,'--help');
    const displayed = output && /^(?:[\w.-]+[ \t]+)?(v?\d+(?:\.\d+){1,3})$/iu.exec(output);
    if (!displayed || normalizedVersion(displayed[1]) !== first.version || !/^usage\s*:/iu.test(help ?? '')) continue;
    read(archive);
    const archiveName = archive.path.split('/').at(-1);
    const directory = distribution.prefix.replace(/\/$/u,'');
    return {replay:[{...archive,path:'可复走原件/'+archiveName,source:'本案上传的同版源码发行归档'}],
      launch:[
        '在下载包「可复走原件」中找到 '+archiveName+'，完整解压并保持原目录结构。',
        '打开 UTF-8 终端，进入'+(directory ? '解压后的 '+directory+' 目录' : '解压根目录')+
          '。确认当前目录中有 '+entry+'。'+(distribution.environment ? '发行包声明运行环境为 '+distribution.environment+'。' : ''),
        '在该目录执行 '+interpreter+' -m '+module+' --version，核对终端显示 '+output+'。归档内的 PKG-INFO 第 '+distribution.versionLine+' 行也记有该发行版本。',
        '执行 '+interpreter+' -m '+module+' --help，终端显示以 usage: 开头的用法和可用参数。保持当前目录，继续下列操作。',
        '运行版本和帮助的原始输出均可在取件包「参考原件／实操证据」中核对。命令行入口和运行数据应保持在同一份解压目录内。',
      ]};
  }
  return {launch:[],replay:[]};
}

export function operationDraftLines(operations, form=false) {
  if (!operations?.length) return [];
  const record = item=>item.record.path.split('/').at(-1);
  const figures = guiFigures(operations);
  return form ? ['## 同版实操摘要','',...operations.map(item=>
    '- '+item.action+'。记录结果：'+item.results.join('，')+'。依据：'+record(item)),''] :
    ['## 同版实操与结果','',...operations.flatMap((item,index)=>[
      ...(figures.length ? ['### 步骤 '+(index+1)] : []),
      '角色：'+item.role, '前置条件：'+item.precondition,
      '操作：'+item.action, '记录结果：'+item.results.join('，'),
      ...(item.commit ? ['本案复验标识：'+item.version,'实际运行源码提交：'+item.commit] : ['运行版本：'+item.version]),
      '依据：'+record(item),
      ...(figures.length ? ['核对要点：'+item.proof.contains.join('、'),
        '实操截图 '+(index+1)+'：'+figures[index].path.split('/').at(-1)] : []),'',
    ])];
}

export function guiFigures(operations) {
  return operations?.length && operations.every(item=>item.mode === 'gui' && item.proof.screenshot) ?
    operations.map(item=>item.proof.screenshot) : [];
}

export function operationDraftMatches(operations, actual, kind) {
  const lines = operationDraftLines(operations,kind === 'filing-form');
  if (!lines.length) return true;
  return kind === 'filing-manual' ?
    compact(actual).includes(compact(lines.map(line=>line.replace(/^#{2,3} /u,'')).join(''))) :
    actual.includes(lines.join('\n'));
}
