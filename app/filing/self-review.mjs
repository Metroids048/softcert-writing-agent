import { normalizedVersion } from '../runtime-evidence.mjs';
import { maxFiles } from '../files.mjs';

import { featureNames, featureSections } from './feature-evidence.mjs';
import { pdfRows } from './layout.mjs';

const manifestName = '交存核对.json';
const hash = value => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const text = (value, limit=320) => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const normalize = value => value.normalize('NFC').replace(/[\p{Zs}\t]+/gu,' ').trim();
const literal = value => value.normalize('NFC').trim();
const sourceCode = /\.(?:py|cs|java|kt|js|jsx|ts|tsx|vue|svelte|go|rs|c|h|cpp|cc|php|rb|swift|sql|cshtml|razor|html|sh)$/i;
const decode = new TextDecoder('utf-8',{fatal:true});

export function selfReviewInput(state, read) {
  const file = state.entries.find(item=>item.path === manifestName);
  if (!file) return null;
  const result = {path:file.path,sha256:file.hash};
  const fail = error=>({...result,error});
  let data;
  try {
    if (file.size <= 128*1024) data = JSON.parse(decode.decode(read(file)));
  } catch { /* Report the invalid attachment in the current audit. */ }
  if (data?.schema !== 'softcert-review/v1' || !text(data.softwareName,100) ||
      !normalizedVersion(data.version) || !hash(data.archiveSha256) ||
      !Array.isArray(data.source) || data.source.length < 1 || data.source.length > maxFiles ||
      !Array.isArray(data.manuals) || data.manuals.length < 1 || data.manuals.length > 5) {
    return fail('交存核对附件格式无效。请补版本、源码包、按顺序列出的源码文件和逐功能材料。');
  }
  return {...result,data};
}

export function selectReviewedSource(state, input, read) {
  const {data} = input ?? {};
  if (!data) return null;
  const version = normalizedVersion(data.version);
  const sameRelease = state.preflight.versionCheck.groups.release.some(item=>item.version === version &&
    item.name.normalize('NFC').toLowerCase() === data.softwareName.normalize('NFC').toLowerCase() &&
    item.archiveSha256 === data.archiveSha256);
  const archive = state.containers.find(file=>file.hash === data.archiveSha256);
  const entries = new Map(state.entries.map(file=>[file.path,file]));
  const paths = data.source.map(ref=>ref?.path);
  if (!state.target?.confirmedAt || state.target.version !== version || !sameRelease || !archive ||
      new Set(paths).size !== paths.length || !data.source.every(ref=>{
        const file = entries.get(ref?.path);
        return text(ref?.path,480) && sourceCode.test(ref.path) && hash(ref.sha256) &&
          file?.hash === ref.sha256 && file.container?.hash === archive.hash && file.size > 0;
      })) return null;
  read(archive);
  return {paths,softwareName:data.softwareName,version,
    sourceSnapshot:{archiveSha256:archive.hash,scopePath:input.path,scopeSha256:input.sha256},
    basis:'从已确认的发布 ZIP 按自备材料核对清单的顺序排版，指纹 '+input.sha256+'。'};
}

function sourceRows(layout) {
  const rows = pdfRows(layout.items.filter(item=>item.y < layout.height-69 && item.y > 45));
  const left = Math.min(...rows.map(row=>row.x));
  return rows.map(row=>({text:row.text.trimEnd(),offset:row.x-left}));
}

export function uploadedSourceMatch(file, detail, candidates, details) {
  if (!detail?.layout?.length) return null;
  const supplied = detail.layout.map(sourceRows);
  for (const expected of candidates) {
    const baseline = details.get(expected.path)?.layout;
    if (!baseline?.length || supplied.some(page=>!page.length)) continue;
    let mismatch = null;
    for (const [index, page] of baseline.entries()) {
      const actual = supplied[index] ?? [];
      const reference = sourceRows(page);
      const changed = reference.findIndex((row,n)=>row.text !== actual[n]?.text ||
        Math.abs(row.offset-actual[n]?.offset) > 1.5);
      if (!reference.length || actual.length !== reference.length || changed !== -1) {
        mismatch = {page:index+1,row:changed === -1 ? Math.min(actual.length,reference.length)+1 : changed+1};
        break;
      }
    }
    const exact = !mismatch && baseline.length === supplied.length;
    const actual = supplied.flat();
    const reference = baseline.flatMap(sourceRows);
    const numbered = actual.map(row=>/^(\d{1,9})\s*\| (.*)$/u.exec(row.text));
    const continuous = numbered.every((row,index)=>row && Number(row[1]) === Number(numbered[0][1])+index);
    const reorderedPages = actual.length === reference.length && reference.every((row,index)=>
      (continuous ? numbered[index][2] : actual[index].text) === row.text &&
      Math.abs(row.offset-actual[index].offset) <= 1.5);
    if (exact || reorderedPages) return {path:file.path,sha256:file.hash,volume:expected.volume,
      reference:expected.path,referenceSha256:expected.hash,pages:supplied.length,
      matchMode: exact ? '同页行' : '全文行序'};
  }
  return null;
}

function checkStep(step, section, runtime, manual, resultContains, after) {
  if (![step?.role,step?.precondition,step?.action,step?.expected].every(value=>text(value))) return null;
  const actionIndex = section?.rows.findIndex((row,index)=>index>after &&
    literal(row.body.replace(/^操作\s*[:：]\s*/u,'')) === literal(step.action)) ?? -1;
  // Use the lines immediately around this action. Reusing the role or the
  // output of another step could turn a contradictory description into a pass.
  const role = section?.rows[actionIndex-2];
  const precondition = section?.rows[actionIndex-1];
  const action = section?.rows[actionIndex];
  const expected = action && section.rows[actionIndex+1];
  const equals = (row,label,value,canonical)=>!!row && label.test(row.body) &&
    canonical(row.body.replace(label,'')) === canonical(value);
  const ordered = actionIndex-2>after && equals(role,/^角色\s*[:：]\s*/u,step.role,normalize) &&
    equals(precondition,/^前置(?:条件)?\s*[:：]\s*/u,step.precondition,normalize) &&
    equals(expected,/^(?:结果|预期结果)\s*[:：]\s*/u,step.expected,literal);
  const matches = runtime.records.filter(record=>['部分已对照','步骤待补'].includes(record.status)).flatMap(record=>
    record.steps.filter(item=>item.action === step.action &&
      normalize(item.role) === normalize(step.role) && normalize(item.precondition) === normalize(step.precondition) &&
      item.locations.some(location=>location.path === manual.path && location.sha256 === manual.hash &&
        (location.page ?? 1) === action?.page && location.line === action?.line))
      .map(item=>({record,item})));
  const conflict = matches.some(({item})=>item.expected !== step.expected || item.status === '运行产物不符' ||
    item.status === '已对照' && !resultContains(item.proof.path,step.expected));
  const valid = matches.find(({item})=>item.status === '已对照' && item.proof.contains.includes(step.expected));
  const runtimeProof = !conflict && valid ? {record:valid.record.path,sha256:valid.record.sha256,
    versionProof:valid.record.versionProof,output:valid.item.proof} : null;
  return {...step,locations:{role,precondition,action,expected},inManual:!!ordered,conflict,
    end:ordered ? actionIndex+1 : after,runtime:runtimeProof};
}

export function reviewSelfManuals({state,input,details,byPath,read,manuals,runtime,original}) {
  const {candidate} = state;
  const sourceMap = candidate.sourceMap;
  const entries = new Map(state.entries.map(file=>[file.path,file]));
  const runtimeLines = new Map();
  const resultContains = (path,expected)=>{
    if (!runtimeLines.has(path)) {
      runtimeLines.set(path,new Set(decode.decode(read(entries.get(path))).split(/\r?\n/u).map(literal)));
    }
    return runtimeLines.get(path).has(normalize(expected));
  };
  const sourced = new Map(sourceMap?.files.map(file=>[file.path,file.sha256]));
  const parsedSource = new Map();
  const sourceRef = ref=>{
    const file = entries.get(ref?.path);
    if (!file || !hash(ref.sha256) || file.hash !== ref.sha256 || sourced.get(file.path) !== ref.sha256 ||
        !Number.isSafeInteger(ref.line) || ref.line < 1 || !text(ref.anchor,240)) return null;
    if (!parsedSource.has(file.path)) {
      try { parsedSource.set(file.path,decode.decode(read(file)).split(/\r?\n/u)); }
      catch { parsedSource.set(file.path,[]); }
    }
    const source = parsedSource.get(file.path)[ref.line-1];
    return source?.includes(ref.anchor) ? {path:file.path,sha256:file.hash,line:ref.line,anchor:ref.anchor} : null;
  };
  const declarations = input?.data?.manuals ?? original?.manuals ?? [];
  const reviews = manuals.map(manual=>{
    const rows = [];
    const matching = declarations.filter(item=>item?.path === manual.path);
    const declaration = matching[0];
    const failure = detail=>({path:manual.path,sha256:manual.hash,detail,status:'范围待核',features:rows});
    if (!input && !declaration) return failure('核心功能、操作、实际结果和源码出处待逐项对照。此说明书保留供复核。');
    if (input?.error) return failure(input.error);
    if (matching.length !== 1 || declaration.sha256 !== manual.hash) return failure('缺少与这份说明书指纹一致的功能核对清单。');
    if (!sourceMap || input && (sourceMap.source_snapshot?.archiveSha256 !== input.data.archiveSha256 ||
        sourceMap.source_snapshot?.scopeSha256 !== input.sha256)) return failure('声明的功能尚未绑定本次确认的发布源码和交存范围。');
    const confirmed = declaration.features;
    if (!Array.isArray(confirmed) || confirmed.length < 1 || confirmed.length > 50) return failure('没有可核的核心功能清单。');
    const detail = details.get(manual.path);
    const formFiles = candidate.files.filter(file=>byPath.get(file.path)?.role === 'form');
    const formScopes = input ? formFiles.flatMap(file=>featureNames(file,details.get(file.path))) : original.names;
    const sections = featureSections(detail,[...new Set(formScopes.map(row=>row.name))]);
    const names = new Set();
    for (const feature of confirmed) {
      if (!text(feature?.name,120) || !Array.isArray(feature.steps) || !feature.steps.length || feature.steps.length > 24 ||
          !Array.isArray(feature.source) || !feature.source.length || feature.source.length > 20 ||
          names.has(normalize(feature.name))) return failure('核心功能重复或缺角色、步骤、预期结果或源码定位。');
      names.add(normalize(feature.name));
      const matchingSections = sections.filter(section=>normalize(section.name) === normalize(feature.name));
      const section = matchingSections.length === 1 ? matchingSections[0] : null;
      const source = feature.source.map(sourceRef);
      let after = -1;
      const steps = feature.steps.map(step=>{
        const result = checkStep(step,section,runtime,manual,resultContains,after);
        if (!result) return null;
        const {end,...review} = result;
        after = end;
        return review;
      });
      const form = formScopes.filter(row=>normalize(row.name) === normalize(feature.name));
      const outcomes = section?.rows.filter(row=>/^(?:结果|预期结果)\s*[:：]/u.test(row.body));
      const consistent = (input || feature.complete) && outcomes?.length === steps.length && source.every(Boolean) &&
        steps.every(step=>step?.inManual && !step.conflict) &&
        (!formScopes.length || form.length > 0);
      rows.push({name:feature.name,heading:section?.heading ?? null,form,source,steps,
        status:!consistent ? '待核或不一致' :
          form.length && steps.every(step=>step.runtime) ? '同版结果已对照' : '静态已对照'});
    }
    const extra = sections.filter(section=>!names.has(normalize(section.name)))
      .map(section=>({name:section.name,...section.heading}));
    const extraForm = formScopes.filter(row=>!names.has(normalize(row.name)));
    const status = extra.length || extraForm.length || rows.some(row=>row.status === '待核或不一致') ? '内容待核' :
      rows.every(row=>row.status === '同版结果已对照') ? '逐项结果已对照' : '静态已对照';
    return {path:manual.path,sha256:manual.hash,status,features:rows,extra,extraForm,
      detail:status === '内容待核' ? '功能、角色与前置、操作、实际结果或源码出处中有待对照项。' :
        status === '静态已对照' ? '所列功能已定位到正文与同版源码，尚需补齐表内功能或可绑定的实际结果。' :
          '所列功能的正文、固定源码和上传的同版操作结果均已定位。申报范围仍由经办人确认。'};
  });
  const unmatched = (input ? declarations : []).filter(row=>!manuals.some(file=>file.path === row?.path)).map(row=>row?.path ?? '未填写路径');
  return {input:input && {path:input.path,sha256:input.sha256,error:input.error},reviews,unmatched};
}
