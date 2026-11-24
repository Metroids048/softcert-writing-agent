import { normalizeChinese, selfReviewPages } from './layout.mjs';

const clean = value => normalizeChinese(value).replace(/^#{1,6}\s+|^[-*]\s+/u,'').trim();
const compact = value => normalizeChinese(value).replace(/\s+/gu,'').replaceAll('：',':').replaceAll('`','');
const splitNames = value => value.split(/[、，,；;。]/u).map(clean).filter(Boolean);
const labels = [
  ['role','角色'],['precondition','前置条件'],['action','操作'],['expected','预期结果'],
];
const decoder = new TextDecoder('utf-8',{fatal:true});

export function featureNames(file, detail) {
  return (detail?.pages ?? []).flatMap((page,index)=>{
    let featureList = false;
    return page.lines.flatMap((value,line)=>{
      if (/^#{1,6}\s+/u.test(value)) featureList = /^(?:软件)?(?:主要功能|核心功能)$/u.test(clean(value));
      const field = /^(?:软件)?(?:主要功能|核心功能)\s*[:：]\s*(.{1,600})$/u.exec(clean(value));
      const list = featureList && /^\s*\d+[.、]\s+([^，。！？：]{2,40})[。！？：]/u.exec(value);
      const names = field ? splitNames(field[1]) : list ? [list[1]] : [];
      return names.map(name=>({name,path:file.path,sha256:file.hash,page:index+1,line:line+1}));
    });
  });
}

export function featureSections(detail, knownNames = []) {
  const sections = [];
  let section;
  for (const [index,page] of (detail?.pages ?? []).entries()) {
    for (const [line,value] of page.lines.entries()) {
      const body = clean(value);
      const numbered = body.replace(/^\d+(?:\.\d+)*[.、．]?\s+/u,'');
      const name = /^功能\s*[:：]\s*(.{1,120})$/u.exec(body)?.[1] ??
        knownNames.find(item=>compact(numbered) === compact(item));
      const location = {page:index+1,line:line+1};
      if (name) {
        section = {name:clean(name),heading:location,rows:[]};
        sections.push(section);
      } else if (section && body && !/^第\s*\d+\s*页$/u.test(body)) {
        section.rows.push({...location,body});
      }
    }
  }
  return sections;
}

function stepsOf(section) {
  const matcher = [
    /^角色\s*[:：]\s*(.{1,300})$/u,
    /^前置(?:条件)?\s*[:：]\s*(.{1,300})$/u,
    /^操作\s*[:：]\s*(.{1,300})$/u,
    /^(?:预期结果|结果)\s*[:：]\s*(.{1,300})$/u,
  ];
  const steps = [];
  const boundaryGaps = [];
  let pending = {};
  let prior;
  let signals = 0;
  for (const row of section.rows) {
    const fields = matcher.map(pattern=>pattern.exec(row.body)?.[1]);
    const index = fields.findIndex(Boolean);
    if (prior?.index >= 0 && row.page === prior.row.page+1 && index === -1 &&
        /[，、：:（(或及与和]$/u.test(prior.row.body)) {
      boundaryGaps.push({from:prior.row.page,to:row.page});
    }
    prior = {index,row};
    if (index === -1) continue;
    signals++;
    if (index === 0) pending = {};
    const [key] = labels[index];
    if (index !== Object.keys(pending).length) continue;
    pending[key] = fields[index];
    if (index === 3 && Object.keys(pending).length === labels.length) {
      steps.push({...pending});
      pending = {};
    }
  }
  return {steps,boundaryGaps,complete:steps.length > 0 && signals === steps.length*labels.length && !boundaryGaps.length};
}

export function originalFeatures(state, inspected, selection, read, omissions) {
  const files = new Map(state.entries.map(file=>[file.path,file]));
  const details = new Map(inspected.details.map(file=>[file.path,file]));
  const names = inspected.report.files.filter(file=>file.role === 'form')
    .flatMap(file=>featureNames(file,details.get(file.path)));
  const scope = new Set(selection?.paths);
  const sources = new Map();
  const sourceAt = row=>{
    const hit = /^(?:源码|实现出处|源码位置)\s*[:：]\s*`?([^:`]+):(\d+)`?\s*$/u.exec(row.body);
    if (!hit) return null;
    const [,suffix,line] = hit;
    const matches = [...scope].filter(path=>path === suffix || path.endsWith('/'+suffix));
    if (matches.length !== 1) return null;
    const [path] = matches;
    const file = files.get(path);
    if (!sources.has(path)) {
      try { sources.set(path,decoder.decode(read(file)).split(/\r?\n/u)); }
      catch { sources.set(path,[]); }
    }
    const anchor = sources.get(path)[Number(line)-1]?.trim();
    return anchor && anchor.length <= 240 ? {path,sha256:file.hash,line:Number(line),anchor} : null;
  };
  const manuals = inspected.report.files.filter(file=>file.role === 'manual' && !omissions.has(file.path)).flatMap(file=>{
    const declared = [...new Set(names.map(row=>row.name))];
    const features = featureSections({pages:selfReviewPages(details.get(file.path))},declared).map(section=>{
      const {steps,complete,boundaryGaps} = stepsOf(section);
      const sourceLines = section.rows.filter(row=>/^(?:源码|实现出处|源码位置)\s*[:：]/u.test(row.body));
      const source = sourceLines.map(sourceAt);
      return {name:section.name,heading:section.heading,steps,source,boundaryGaps,
        complete:complete && source.length > 0 && source.every(Boolean)};
    });
    return features.length ? [{path:file.path,sha256:file.hash,features}] : [];
  });
  return {names,manuals};
}

export function featureDraftLines(evidence) {
  const features = evidence?.manuals.flatMap(manual=>manual.features.filter(feature=>feature.complete)
    .map(feature=>({manual,feature}))) ?? [];
  if (!features.length) return [];
  return ['## 功能、操作与出处','',...features.flatMap(({manual,feature})=>[
    '功能：'+feature.name,
    ...feature.steps.flatMap(step=>labels.map(([key,label])=>label+'：'+step[key])),
    '原件：'+manual.path+' 第 '+feature.heading.page+' 页第 '+feature.heading.line+' 行',
    ...feature.source.map(ref=>'源码：'+ref.path+':'+ref.line),'',
  ])];
}

export function featureDraftCheck(evidence, actual, sourceMap, pdf) {
  const lines = featureDraftLines(evidence);
  if (!lines.length) return {missing:false,sourceMismatch:false};
  const block = compact(lines.join('').replace(/^## /u,''));
  const body = compact(actual);
  const source = new Map(sourceMap?.files.map(file=>[file.path,file.sha256]));
  return {
    missing:pdf ? !body.includes(block) : !actual.includes(lines.join('\n')),
    sourceMismatch:evidence.manuals.some(manual=>manual.features.some(feature=>
      feature.complete && feature.source.some(ref=>source.get(ref.path) !== ref.sha256))),
  };
}

