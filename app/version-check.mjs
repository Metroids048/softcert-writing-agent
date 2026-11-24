import { packageFacts } from './filing/evidence.mjs';
import { normalizedVersion, runtimeVersionInputs } from './runtime-evidence.mjs';
import { JSZip } from './runtime.mjs';
import { safePath } from './intake-paths.mjs';

const basename = path => path.split('/').at(-1);
const parent = path => path.slice(0,path.lastIndexOf('/')+1);
const nameKey = name => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const releaseFile = /(?:^|\/)release\.json$/i;
const ignoredTree = /(?:^|\/)(?:node_modules|vendor|third_party|tests?|fixtures|examples?)(?:\/|$)/i;
const sourceFile = /\.(?:py|js|jsx|ts|tsx|go|rs|java|kt|cs|c|cpp|h|swift|rb|php|vue|svelte|sql|sh)$/i;
const labels = {release:'发布版本',runtime:'实际运行版本',manuscript:'稿件版本',target:'拟申报版本'};
const versionField = /^(?:软件版本(?:号)?|当前版本|版本号?|构建版本|(?:software )?version|build version)\s*(?:[:=|]\s*|\s+)(v?\d+(?:\.\d+){1,3})$/iu;
const splitField = /^(?:软件版本(?:号)?|当前版本|版本号?|构建版本|(?:software )?version|build version)\s*[:=]?$/iu;
const versionTitle = /^.{1,100}\s+V\s*(\d+(?:\.\d+){1,3})(?:\s*(?:软件|系统)?\s*(?:操作手册|用户手册|使用手册|[设计使用操作]*说明书|申请表|user manual|manual))?$/iu;
const evidenceText = item => [item.version ?? '待核',item.path,item.location].filter(Boolean).join(' · ');
const rows = (detail) => (detail?.pages ?? []).flatMap(page=>page.lines);

function releases(details, entries) {
  const candidates = details.filter(file=>!ignoredTree.test(file.path));
  const byPath = new Map(candidates.map(file=>[file.path,file]));
  const facts = packageFacts(candidates,entries);
  for (const file of candidates.filter(item=>releaseFile.test(item.path))) {
    let data;
    try { data = JSON.parse(rows(file).join('\n')); } catch { continue; }
    const version = normalizedVersion(data?.version);
    if (version && typeof data.softwareName === 'string' && data.softwareName.trim()) {
      facts.push({path:file.path,name:data.softwareName,version});
    }
  }
  const results = new Map();
  for (const fact of facts) {
    const source = entries.get(fact.path);
    if (!source) continue;
    const isToml = basename(fact.path).toLowerCase() === 'pyproject.toml';
    const line = rows(byPath.get(fact.path)).findIndex(text=>(isToml ?
      /^\s*version\s*=\s*["']([^"']+)["']/i : /"version"\s*:\s*"([^"]+)"/).exec(text)?.[1]?.replace(/^v/i,'') === fact.version.slice(1));
    const versionLine = fact.versionLine ?? (line >= 0 ? line+1 : null);
    results.set(fact.path,{path:fact.path,name:fact.name,version:fact.version,sha256:source.hash,archiveSha256:source.container?.hash,
      location:versionLine ? '第 '+versionLine+' 行 version 字段' : 'version 字段'});
    for (const filename of ['VERSION','VERSION.txt']) {
      const path = parent(fact.path)+filename;
      const item = entries.get(path);
      const version = normalizedVersion(rows(byPath.get(path)).join('\n'));
      if (item && version) results.set(path,{path,name:fact.name,version,sha256:item.hash,
        archiveSha256:item.container?.hash,location:'版本文件正文'});
    }
  }
  return [...results.values()];
}

export function manuscriptVersions(files, details) {
  const byPath = new Map(details.map(detail=>[detail.path,detail]));
  return files.filter(file=>['form','manual'].includes(file.role)).flatMap(file=>{
    const detail = byPath.get(file.path);
    let fence = '';
    const evidence = new Map();
    for (const [pageIndex,page] of (detail?.pages ?? []).entries()) {
      const ocr = detail.ocr?.pages.some(item=>item.page === pageIndex+1);
      for (const [index,line] of page.lines.entries()) {
        const raw = line.normalize('NFKC').trim();
        const marker = /^(`{3,}|~{3,})/u.exec(raw)?.[1];
        if (fence) {
          if (marker?.[0] === fence[0] && marker.length >= fence.length && raw === marker) fence = '';
          continue;
        }
        if (marker) { fence = marker; continue; }
        const clean = raw.replace(/^[#|\s]+|[|\s]+$/gu,'').replace(/[`*_]/gu,'').replace(/\s+/gu,' ');
        const following = page.lines[index+1]?.normalize('NFKC').trim();
        const field = versionField.exec(clean)?.[1] ?? (splitField.test(clean) ? following : undefined);
        const version = normalizedVersion(field ?? (index < 3 ? versionTitle.exec(clean)?.[1] : undefined));
        if (!version) continue;
        const range = (index+1)+(splitField.test(clean) ? '–'+(index+2) : '');
        const location = page.label ? page.label+' 第 '+range+' 行' :
          /\.docx$/i.test(file.path) ? '段落 '+range : '第 '+range+' 行';
        const item = {path:file.path,sha256:file.hash,role:file.role,location,version,ocr:!!ocr,
          kind:field ? 'field' : 'title'};
        // Preserve every distinct version per file as well as the first title and field.
        const key = version+'|'+item.kind+'|'+item.ocr;
        if (!evidence.has(key)) evidence.set(key,item);
      }
    }
    return evidence.size ? [...evidence.values()] : [{path:file.path,sha256:file.hash,role:file.role,
      location:'未找到可核的正文版本'}];
  });
}

async function archiveSources(archive, read) {
  const {files} = await JSZip.loadAsync(read(archive));
  return Object.values(files).flatMap(file=>{
    const path = safePath(file.unsafeOriginalName ?? file.name);
    return !file.dir && path && !ignoredTree.test(path) && sourceFile.test(path) ? [path] : [];
  });
}

export async function checkVersions(state, {report,details,versionEdits}, read, draftsNewDocuments=false, fixedRun=null, staticRelease=null) {
  const entries = new Map(state.entries.map(file=>[file.path,file]));
  const release = releases(details,entries);
  if (staticRelease) {
    const {path,name,version,sha256,archiveSha256,location} = staticRelease;
    release.push({path,name,version,sha256,archiveSha256,location});
  }
  const manuscript = manuscriptVersions(report.files,details).filter(item=>{
    if (!/^readme(?:\.[^.]+)?$/iu.test(basename(item.path))) return true;
    const archive = entries.get(item.path)?.container?.hash;
    return !archive || !release.some(released=>
      released.archiveSha256 === archive && item.path.startsWith(parent(released.path)));
  }).map(item=>{
    if (item.version || item.role !== 'manual') return item;
    const matches = state.entries.filter(entry=>entry.hash === item.sha256 && entry.container?.hash);
    const sources = release.filter(released=>matches.some(entry=>
      parent(entry.path) === parent(released.path) && entry.container.hash === released.archiveSha256 &&
      /\.(?:md|rst|docx|pdf|txt)$/iu.test(entry.path)));
    if (!sources.length || new Set(sources.map(source=>source.version)).size !== 1) return item;
    const [source] = sources;
    const member = matches.find(entry=>parent(entry.path) === parent(source.path) &&
      entry.container.hash === source.archiveSha256);
    return {...item,version:source.version,kind:'archive-member',location:'字节与发布包成员 '+member.path+' 一致',
      releasePath:source.path,archiveSha256:source.archiveSha256};
  });
  const observed = new Set(release.map(item=>item.version));
  const reference = observed.size === 1 ? release[0].version : state.target?.version;
  const target = state.target ? [{version:state.target.version,location:'网页手动确认'}] : [];
  const runtime = [];
  const questions = [];
  const ask = (title,detail,conflict=false,owner='开发方 / 经办人') => {
    questions.push({id:'R2',owner,title,detail,conflict});
  };
  const archiveByHash = new Map(state.containers.map(archive=>[archive.hash,archive]));
  const sourcesByArchive = new Map();
  const probes = [];
  for (const probe of runtimeVersionInputs(state.entries,read)) {
    if (probe.commitProbe) {
      const fixed = !!fixedRun && fixedRun.archiveSha256 === probe.archiveSha256 &&
        nameKey(fixedRun.softwareName) === nameKey(probe.softwareName);
      const stat = staticRelease?.archiveSha256 === probe.archiveSha256 && staticRelease &&
        nameKey(staticRelease.name) === nameKey(probe.softwareName);
      const bound = fixed || !!(stat && staticRelease.proof);
      const staticArchive = !!(stat && staticRelease.proof?.recordPath === probe.path &&
        staticRelease.proof.recordSha256 === probe.sha256);
      probes.push({...probe,bound,staticArchive,...(fixed && {confirmedVersion:fixedRun.internalVersion,confirmedCommit:fixedRun.commit}),
        ...(stat && {confirmedVersion:staticRelease.version,confirmedCommit:staticRelease.commit})});
      continue;
    }
    const matched = release.filter(item=>item.archiveSha256 && item.archiveSha256 === probe.archiveSha256 &&
      nameKey(item.name) === nameKey(probe.softwareName));
    const archive = archiveByHash.get(probe.archiveSha256);
    if (matched.length && archive && !sourcesByArchive.has(archive.hash)) {
      sourcesByArchive.set(archive.hash,await archiveSources(archive,read));
    }
    const sourcePaths = sourcesByArchive.get(probe.archiveSha256) ?? [];
    const bound = matched.some(item=>{
      const paths = sourcePaths.filter(path=>path.startsWith(parent(item.path)));
      return paths.length && paths.every(path=>entries.get(path)?.container?.hash === probe.archiveSha256);
    });
    const versions = new Set(matched.map(item=>item.version));
    probes.push({...probe,bound,releaseVersion:versions.size === 1 ? matched[0].version : null});
  }
  if (!release.length) ask('补发布版本证据','请补当前发布清单、能核版本的项目清单或同版源码包。');
  if (observed.size > 1) ask('确认唯一的发布版本',release.map(evidenceText).join('；')+
    '。请确认本案唯一发布件，替换或撤回异版文件。',true);
  if (observed.size === 1 && target.length && target[0].version !== reference) {
    ask('核对拟申报版本','网页确认 '+target[0].version+'，发布证据为 '+evidenceText(release[0])+
      '。请确认哪个版本应申报，并提供对应的证据。',true);
  }
  for (const probe of probes) {
    if (probe.commitProbe) {
      const {reportedCommit,confirmedCommit,confirmedVersion,declaredVersion,versionProof,bound,path,sha256} = probe;
      const location = reportedCommit ? '实际启动的归档源码提交 '+reportedCommit : '未读取到完整的实际运行源码提交';
      runtime.push({path:versionProof?.path ?? path,sha256:versionProof?.sha256 ?? sha256,
        ...(bound && {version:confirmedVersion}),location: bound ? location+'；'+confirmedVersion+
          (probe.staticArchive ? ' 为归档项目声明的发布版次，运行响应与归档文件吻合' : ' 为本案确认的快照版次') :
          location+'；未绑定本案确认快照'});
      if (!bound || !reportedCommit) {
        ask('补固定源码运行证据',path+'。请确认本案内部版次及固定源码，补同名同源的实际运行提交。');
      } else if (reportedCommit !== confirmedCommit || declaredVersion !== confirmedVersion) {
        ask('核对固定源码运行提交',path+'。已确认 '+confirmedVersion+' 对应 '+confirmedCommit+
          '；记录声明 '+declaredVersion+'，实际运行提交为 '+reportedCommit+'。',true);
      }
      continue;
    }
    if (!probe.bound || !probe.reportedVersion) {
      runtime.push({path:probe.versionProof?.path ?? probe.path,sha256:probe.versionProof?.sha256 ?? probe.sha256,
        version:probe.reportedVersion,location:probe.bound ? '无法读回已绑定的版本输出' : '未能绑定到当前发布源码，待核'});
      ask('补可绑定的运行版本输出',probe.path+'。请补该发布源码 ZIP 的指纹、同名软件的运行记录和实际版本命令输出。');
      continue;
    }
    const result = {path:probe.versionProof.path,sha256:probe.versionProof.sha256,version:probe.reportedVersion,
      location:'实际版本命令输出，记录 '+probe.path};
    runtime.push(result);
    if (probe.releaseVersion && (probe.reportedVersion !== probe.releaseVersion ||
        probe.declaredVersion !== probe.releaseVersion)) {
      const basis = release.find(item=>item.archiveSha256 === probe.archiveSha256 && item.version === probe.releaseVersion);
      ask('确认发布包和程序实际显示版本',evidenceText(basis)+'；'+evidenceText(result)+'；运行记录声明 '+probe.declaredVersion+
        '。请确认该发布包是否应显示 '+probe.releaseVersion+'。核查构建时嵌入的版本或实际安装包，修正后上传同一构建的新版本输出。',true);
    }
  }
  if (!probes.length) ask('补实际运行版本','请从拟申报的构建中取实际版本命令输出，并随同版实操记录上传。',false,'开发方');
  const planned = [];
  const documentVersions = new Set(manuscript.flatMap(item=>item.version ?? []));
  for (const hit of manuscript) {
    if (!hit.version) continue;
    if (reference ? hit.version === reference : documentVersions.size < 2) continue;
    const edit = versionEdits.find(item=>item.path === hit.path && item.loc === hit.location &&
      normalizedVersion(reference) && item.after.includes(reference));
    if (edit && !hit.ocr) planned.push({...hit,to:reference});
    else ask('核对稿件里的版本',evidenceText(hit)+(hit.ocr ? '（扫描识别，请回对原页）' : '')+
      (reference ? '，本案核对版本为 '+reference : '，与其他稿件或正文位置的版本不同')+
      '。请确认此稿适用的版本并替换为同版稿件。',true,'经办人 / 文档整理人');
  }
  for (const hit of manuscript.filter(item=>!item.version)) ask('确认稿件适用版本',
    hit.path+' 未找到可核的正文版本。请补署明版本的稿件，或提供对应发布记录。',false,'经办人');
  if (!manuscript.length && !draftsNewDocuments) {
    ask('核对稿件版本','若需要复核既有稿件，请提供有明确版本号的申请表或说明书。',false,'经办人');
  }
  const blocking = questions.some(item=>item.conflict);
  const status = blocking ? 'conflict' : planned.length ? 'planned' : questions.length ? 'pending' : 'matched';
  return {status,blocking,reference,groups:{release,runtime,manuscript,target},questions,planned,probes};
}

export const versionSummary = {
  conflict:'发现版本冲突，已暂缓起草和写回。',
  pending:'版本证据待补，可按当前依据整理内部底稿。',
  planned:'发现可依据同版发布证据安全写回的稿件字段，写回后复验。',
  matched:'目前已取得的发布、实际运行和稿件版本证据一致。',
};

export function versionReport(check) {
  return ['# R2 起草前版本核对','',versionSummary[check.status],'',
    ...Object.entries(check.groups).flatMap(([key,items])=>[
      '## '+labels[key],'',...(items.length ? items.map(item=>'- '+evidenceText(item)+
        (item.ocr ? '（扫描识别）' : '')+(item.sha256 ? '\n  - SHA-256 `'+item.sha256+'`' : '')) : ['- 未提供可核证据。']),'',
    ]),
    ...(check.planned.length ? ['## 可安全写回的位置','',...check.planned.map(item=>
      '- '+evidenceText(item)+' → '+item.to),''] : []),
    '## 待确认事项','',...(check.questions.length ? check.questions.map(item=>
      '- '+item.owner+'｜'+item.title+'。'+item.detail) : ['- 起草前未发现版本待确认事项。']),'',
  ].join('\n');
}
