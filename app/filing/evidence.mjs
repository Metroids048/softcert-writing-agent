import { crossCheckOCR, exampleLine, ocrReport, outputText } from './ocr-evidence.mjs';
import { english, englishTitle } from './localize.mjs';
import { applicationDraftLines, applicationReport } from '../application-check.mjs';
import { separateManualClaims } from './manual-claims.mjs';
import { attributeMeasurements, measurementReport } from './measurements.mjs';
import { bindTableReferences, tableCaptions, tableIndex } from './table-references.mjs';
import { manualTableRows, tableExamples, tableSection } from './manual-tables.mjs';
import { featureDraftLines } from './feature-evidence.mjs';
import { operationDraftLines } from '../runtime-evidence.mjs';
import { launchLines } from './packaged-web.mjs';

export function sourceLayoutSummary(sourceMap) {
  const supplements = sourceMap.runtime_resource_scope?.supplements.length ?? 0;
  const total = sourceMap.files.length;
  const origin = supplements ? '，含 '+(total-supplements)+' 个上传源文件和 '+supplements+' 个同版核验的补充源文件' : '';
  return '排版覆盖 '+total+' 个源文件'+origin+'，共 '+sourceMap.full_page_count+' 个逻辑页。';
}
import { continuationSource, manualContinuations } from './manual-continuations.mjs';

// Facts come from the frozen upload and have a location that can be checked in the download.
const versionValue = value => value?.trim().match(/^v?(\d+(?:\.\d+){1,3})$/iu)?.[1];
const plain = value => value.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[`*]/g,'').trim();
const readingText = value => value.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\*{1,2}/g,'').trim();
const canonical = value => value.normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
const prose = value => value.replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han}|[，。；：！？])/gu,'')
  .replace(/[ \t]+/g,' ').trim();

export function packageFacts(details, entries = new Map()) {
  const facts = details.flatMap(({path,pages,package: data})=>{
    const manifest = pages?.[0]?.lines.join('\n');
    const coreMetadata = /(?:^|\/)PKG-INFO$/iu.test(path);
    let versionLine;
    if (coreMetadata) {
      // Use the distribution's root metadata, not generated egg-info copies or body text.
      if (/(?:^|\/)[^/]+\.egg-info\//iu.test(path) || !manifest) return [];
      const headers = manifest.split(/\n\s*\n/u,1)[0].split('\n');
      const field = key => {
        const pattern = new RegExp('^'+key+':[ \\t]*(.+)$','iu');
        const matches = headers.flatMap((line,index)=>{
          const match = pattern.exec(line);
          return match ? [{value:match[1].trim(),line:index+1}] : [];
        });
        return matches.length === 1 ? matches[0] : undefined;
      };
      if (!/^[12]\.\d+$/u.test(field('Metadata-Version')?.value ?? '')) return [];
      const version = field('Version');
      versionLine = version?.line;
      data = {name:field('Name')?.value,version:version?.value,description:field('Summary')?.value,
        'requires-python':field('Requires-Python')?.value};
    }
    if (!data && /(?:^|\/)pyproject\.toml$/i.test(path)) {
      const project = manifest?.match(/^\[(?:project|tool\.poetry)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
      if (project) data = Object.fromEntries([...project.matchAll(/^(name|description|version|requires-python)\s*=\s*(["'])(.*?)\2\s*(?:#.*)?$/gm)]
        .map(([,key,,value])=>[key,value]));
    }
    if (!data && /(?:^|\/)package\.json$/i.test(path)) {
      try { data = JSON.parse(pages?.[0]?.lines.join('\n')); } catch { return []; }
    }
    const version = typeof data?.version === 'string' && versionValue(data.version);
    if (!version || typeof data.name !== 'string' || !/^[@\w][\w@/.-]{0,99}$/u.test(data.name)) return [];
    const scripts = manifest?.match(/^\[(?:project|tool\.poetry)\.scripts\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
    const commands = [...(typeof data.bin === 'object' && data.bin ? Object.keys(data.bin) : []),
      ...[...scripts.matchAll(/^([\w-]+)\s*=/gm)].map(([,command])=>command)];
    return [{path,name:data.name,version:'V'+version,commands,...(coreMetadata && {versionLine}),
      description:typeof data.description === 'string' ? data.description.slice(0,320) : '',
      environment:typeof data['requires-python'] === 'string' ? 'Python '+data['requires-python'] : ''}];
  });
  // A static pyproject and equivalent generated metadata from the same root are one release.
  const pythonName = value => value.toLowerCase().replace(/[-_.]+/gu,'-');
  return facts.filter(fact=>!fact.versionLine || !facts.some(other=>
    other.path === fact.path.replace(/PKG-INFO$/iu,'pyproject.toml') &&
    other.version === fact.version && pythonName(other.name) === pythonName(fact.name) &&
    entries.get(other.path)?.container?.hash === entries.get(fact.path)?.container?.hash));
}

const labels = [
  '软件全称','软件简称','版本号','开发完成日期','首次发表日期','首次发表地点',
  '软件分类','开发硬件环境','运行硬件环境','开发软件环境','运行软件环境',
  '编程语言','源程序量','开发目的','面向行业',
];
const fieldAliases = new Map([
  ['软件名称','软件全称'],['软件版本','版本号'],['软件版本号','版本号'],
  ['开发的硬件环境','开发硬件环境'],['运行的硬件环境','运行硬件环境'],
  ['软件开发环境 / 开发工具','开发软件环境'],['软件运行支撑环境 / 支持软件','运行软件环境'],
  ['面向领域 / 行业','面向行业'],
]);
const legalFields = new Set(['首次发表日期','首次发表地点']);
const cleanField = value => {
  const text = plain(value).replace(/^[：:\s]+|[\s|]+$/g,'').trim();
  return text && text.length <= 160 &&
    !/【|待确认|待填|待定|选填|填写内容|^\d*[□☑☐]/u.test(text) &&
    ![...labels,'申请人','著作权人','开发方式','权利取得方式','权利范围'].some(label=>text.startsWith(label)) ? text : null;
};

function formFields(pages) {
  const fields = new Map();
  for (const page of pages) {
    for (const [index,line] of page.lines.entries()) {
      const columns = line.trim().split('|').map(plain);
      if (columns[0] === '') columns.shift();
      const fieldLine = plain(line.replace(/^[-# ]+/, ''));
      const fieldLabel = fieldLine.split(/[:：]/u,1)[0].trim();
      const canonicalLine = fieldAliases.has(fieldLabel) ?
        fieldAliases.get(fieldLabel)+fieldLine.slice(fieldLabel.length) : fieldLine;
      for (const field of labels) {
        const pattern = new RegExp('^'+field+'\\s*(?:[:：]\\s*(.*)|$)','u');
        const hit = canonicalLine.match(pattern);
        const tabular = (fieldAliases.get(columns[0]) ?? columns[0]) === field;
        if (!tabular && !hit) continue;
        const value = cleanField(tabular ? columns[1] ?? '' : hit[1] || page.lines[index+1] || '');
        if (!value || fields.has(field)) continue;
        if (field.endsWith('日期') && !/^(?:未发表|\d{4}[-年./]\s*\d{1,2}[-月./]\s*\d{1,2}日?)$/u.test(value)) continue;
        if (page.ocr && !tabular && !hit[1] && !['版本号','开发完成日期','源程序量','编程语言'].includes(field)) continue;
        if (field === '软件全称' && /^(?:下拉|软件|简称|版本|计算机软件著作权登记申请表)$/u.test(value)) continue;
        const normalized = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.test(value) ?
          value.replace(/[年月]/gu,'-').replace(/日$/u,'') : prose(value);
        fields.set(field,{...page,value:normalized,loc:page.pdf ? '第 '+page.number+' 页' : '第 '+(index+1)+' 行'});
      }
    }
    if (!page.ocr) continue;
    const pageText = page.lines.join('\n');
    const environment = [
      ['运行硬件环境',/(?:^|\n)((?:CPU|处理器)\s*[:：].{10,150})/iu,/硬件环境/u],
      ['运行软件环境',/(?:^|\n)((?:Windows|Linux|macOS|Android|iOS|Ubuntu)\b.{10,150})/iu,/软件环境/u],
    ];
    for (const [field,pattern,label] of environment) {
      const value = label.test(pageText) && pageText.match(pattern)?.[1];
      if (value && !fields.has(field)) fields.set(field,{...page,value:prose(value),loc:'第 '+page.number+' 页'});
    }
  }
  return fields;
}

function manualIdentity(pages) {
  for (const page of pages) {
    for (const line of page.lines.slice(0,6)) {
      const title = line.trim().replace(/^#{1,6}\s+[^\p{L}\p{N}]*/u,'');
      const parts = title.match(/^(.{3,110}?)\s*[Vv](\d+(?:\.\d+){1,3})\s*(?:设计说明书|软件说明书|用户手册|操作手册|说明书|(?:第\s*)?\d+\s*(?:\/\s*\d+|页)|$)/u);
      if (parts && !/\|/u.test(parts[1]) && !/^(?:版本|申请|软件全称)/u.test(parts[1])) {
        return {...page,name:parts[1].trim(),version:'V'+parts[2],loc:'第 '+page.number+' 页'};
      }
    }
  }
}

const sectionTypes = [
  ['环境与准备',/安装|运行环境|软件环境|硬件环境|依赖|准备|install|requirements|prerequisites|setup|quick start/iu],
  ['操作步骤与示例',/操作|使用|选择|点击|输入|流程|运行|编译|启动|调试|步骤|测试|usage|example|render|options|display|commands|format|reading|markdown|syntax|paging/iu],
  ['输出、结果与异常',/输出|结果|保存|验证|异常|出错|失败|缺少|注意|核验|编码|export|output|error|troubleshoot|result/iu],
];
const header = /^(?:#{1,6}\s+|\d+(?:\.\d+)*[.、]\s*|[一二三四五六七八九十]+、\s*)/u;
const junk = /^(?:>\s*(?:用法|下面这段|不要照抄)|!?\[!?\[|<[/!a-z]|\s*\|\s*[-:]|\d+\s*\/\s*\d+|[_=*-]{3,}|.*\.{4,}\s*\d+$)/iu;
const technicalHeading = /主要功能|技术特点/iu;
const referenceHeading = /^(?:features|feature list|browser support|功能列表|功能概览|浏览器兼容性)$/iu;
const repositoryHeading = /^(?:url|preview|embed|build instructions|wiki|contributors?|license|support|change\s*log|测试|运行开发测试|目录|目录结构|项目结构)\s*[:：]?$/iu;
const guiRepositoryHeading = /^(?:successor\b|develop(?:ment|ing)?\b|build(?:ing)?\b|test(?:ing)?\b|contribut(?:e|ing)\b|sponsors?\b|commonjs\b|html script\b|api\b|full example\b|示例代码|通用方法|下载\s*[&和与]\s*安装|开发\s*(?:[&和与]|文档|指南|说明)|贡献指南)/iu;
const packageInstruction = /\b(?:npm|pnpm|yarn)\s+(?:i\s|install\b|add\b|run\b|test\b)|\brequire\s*\(|^import\s+.+\sfrom\s+['"]|^\s*\/\/\s*(?:CommonJS|ES Module)|\b(?:yarnpkg\.com|unpkg\.com|cdnjs\.com|jsdelivr\.com|cdn\.jsdelivr\.net)\b|JavaScript\s*软件包管理器/iu;
const repositoryNotice = /(?:LambdaTest|GitHub (?:Actions|Workflow Status|工作流程状态))|^\s*\[.*\]\(https:\/\/.*(?:badge|shields\.)|^(?:(?:项目|移动版|在线)\s*)?演示地址\s*[:：]|^https?:\/\/\S+$/iu;
const clientBehaviorClaim = /\b(?:nothing (?:will be|is) sent to (?:any|a) server|everything stays in your browser)\b/iu;
const tag = ({path,loc,pdf,number,ocr}) => path+' '+(loc ?? (pdf ? '第 '+number+' 页' : '正文'))+(ocr?'（OCR 待校）':'');
const ref = row => '〔'+tag(row)+(row.sourceOption ? '；选项以 '+row.sourceOption+' 为准' : '')+'〕';

function versionedOptions(entries, sourceMap, read) {
  const paths = new Set(sourceMap?.files.map(file=>file.path));
  const flags = new Map();
  for (const entry of entries.filter(file=>paths.has(file.path) && file.path.endsWith('.py'))) {
    const source = read(entry).toString('utf8');
    for (const match of source.matchAll(/@click\.option\(\s*['"](--[\w-]+)['"]\s*,(?:\s*['"](-[A-Za-z])['"])?/gu)) {
      const [,long,short] = match;
      const line = source.slice(0,match.index).split('\n').length;
      flags.set(long,{short,path:entry.path,location:entry.path+' 第 '+line+' 行'});
    }
  }
  return flags;
}

function paragraphEvidence(pages, form, ocrProse, withoutClaims, continuations = [], gui = false) {
  const rows = [];
  let topic = '';
  let ancestors = [];
  let codeFence = false;
  let previousPath;
  const guiMarkup = page => gui && !page.pdf && /\.md$/iu.test(page.path);
  const repositorySection = page => ancestors.some(item=>repositoryHeading.test(item.title) ||
    guiMarkup(page) && guiRepositoryHeading.test(item.title.replace(header,'').replace(/^[^\p{L}\p{N}]+/u,'')));
  for (const page of pages) {
    if (page.path !== previousPath || form && page.pdf) {
      topic = '';
      ancestors = [];
      codeFence = false;
    }
    previousPath = page.path;
    const continuedLines = new Set(continuations.filter(row=>row.path === page.path)
      .flatMap(row=>row.spans.filter(([number])=>number === page.number)
        .flatMap(([,lines])=>lines.map(({index})=>index))));
    let paragraph = [];
    let first = 0;
    const flush = () => {
      if (!paragraph.length) return;
      let value = paragraph.reduce((text,line)=>text && /[\p{Script=Han}，。；、)]$/u.test(text) &&
        /^\p{Script=Han}/u.test(line) ? text+line : [text,line].filter(Boolean).join(' '),'');
      if (page.pdf && /\p{Script=Han}/u.test(value) && !/[。！？]$/u.test(value)) {
        const lastSentence = Math.max(value.lastIndexOf('。'),value.lastIndexOf('！'),value.lastIndexOf('？'));
        if (lastSentence >= 35) value = value.slice(0,lastSentence+1);
        else if (page.ocr && /(?:[的在允否失可钓]|以及|是否|无法|核对方法|无法直|而不会|这|，)$/u.test(value)) { paragraph=[]; return; }
      }
      const row = {...page,form,topic,ancestors,value,loc:page.pdf ? '第 '+page.number+' 页' : '第 '+(first+1)+' 行'};
      rows.push({...row,value:withoutClaims(row,value)});
      paragraph = [];
    };
    for (const [index,source] of (page.bodyLines ?? page.lines).entries()) {
      if (continuedLines.has(index)) { flush(); continue; }
      const line = prose(page.ocr ? ocrProse.get(page)?.get(source.normalize('NFKC').trim()) ?? source : source);
      const title = line.replace(header,'').trim();
      if (/^```|^~~~/.test(line)) { flush(); codeFence = !codeFence; continue; }
      if (codeFence) {
        if (line && !/^#/.test(line) && line.length < 240 &&
            (form || !repositorySection(page) && !(guiMarkup(page) && packageInstruction.test(line)))) rows.push({...page,form,topic,ancestors,value:source.trim(),command:true,
          loc:page.pdf ? '第 '+page.number+' 页' : '第 '+(index+1)+' 行'});
        continue;
      }
      if (/^#{1,6}\s+/.test(line) || header.test(line) && title.length < 32 && !/[，。；！？]/u.test(title) ||
          form && /^(?:主要功能|和技术特点)$/.test(line)) {
        flush();
        const level = line.match(/^#+(?=\s)/u)?.[0].length;
        topic = plain(title);
        ancestors = level
          ? [...ancestors.filter(heading=>heading.level < level),{level,title:topic}]
          : [{level:2,title:topic}];
        continue;
      }
      if (!form && !page.pdf && (repositorySection(page) ||
          /^\*{0,2}change\s*log\s*[:：]/iu.test(line) ||
          guiMarkup(page) && (packageInstruction.test(line) || repositoryNotice.test(line)))) { flush(); continue; }
      if (!line || junk.test(line) || /^\s*[|>]/u.test(line) ||
          /(?:V\d+(?:\.\d+)+.{0,12}(?:说明书|\d+\s*\/\s*\d+))\s*$/iu.test(line) ||
          line.replace(/[^\p{L}]/gu,'').length<9) { flush(); continue; }
      if (form && !technicalHeading.test(topic)) continue;
      if (form && /^(?:[•·□口]\s*)?(?:提交|打印签字|软件鉴别材料|申请人|代理人身份证明|请按照提示.{0,15}提交|权利归属|前\s*\d+\s*页|目标程序连续|使用.{0,10}斜线|(?:CPU|处理器)\s*[:：]|(?:Windows|Linux|macOS)\b)/iu.test(line)) {
        flush();
        continue;
      }
      if (!paragraph.length) first=index;
      if (page.ocr && ocrProse.get(page)?.get(source.normalize('NFKC').trim()) === '') { flush(); continue; }
      paragraph.push(readingText(line));
      if (/[。！？.!?]$/u.test(line) || paragraph.join('').length >= 390) flush();
    }
    flush();
  }
  return rows.filter(row=>row.command || row.value.length >= 25 && row.value.length <= 470 &&
    !/[\p{Script=Nko}\p{Script=Mandaic}]{2}/u.test(row.value) &&
    !/^(?:提交.{0,16}连续|请确认所需要|填写说明|软件著作权登记申请表)/u.test(row.value));
}

const operationalSignals = [
  /(?:下载安装|安装命令|运行依赖|pipx install|brew install)/iu,
  /(?:点击|按下|选择.{0,35}(?:文件|目录|菜单)|在.{0,25}输入|执行以下|实际.*命令)/iu,
  /(?:保存为|输出为|写入.{0,20}(?:文件|目录)|(?:报错|错误)时|(?:outputs?|writes?)\s+to)/iu,
];

function chooseRows(rows, pattern, max, used, preferred, section = -1) {
  const chosen = [];
  const candidates = rows.map(row=>({row,score:
    (pattern.test(row.originalTopic ?? row.topic) || pattern.test(row.topic) ? 3 : 0)+(pattern.test(row.value) ? 2 : 0)+
    (row.form === preferred && (pattern.test(row.topic) || pattern.test(row.value)) ? 2 : 0)+
    (row.ocr && !row.form && section > 0 && pattern.test(row.value) ? 1 : 0)+
    (section >= 0 && operationalSignals[section].test(row.value) ? 4 : 0)+
    (row.command && /操作|测试/.test(pattern.source) ? 2 : 0)}))
    .filter(({score})=>score>0).sort((a,b)=>b.score-a.score);
  for (const {row} of candidates) {
    const key = canonical(row.value);
    if (used.has(key) || chosen.filter(item=>item.topic === row.topic && item.path === row.path &&
        (!row.pdf || item.number === row.number)).length >= (row.ocr ? 3 : 6)) continue;
    used.add(key);
    chosen.push(row);
    if (chosen.length >= max) break;
  }
  return chosen.sort((a,b)=>a.path.localeCompare(b.path) || a.number-b.number ||
    (Number(a.loc.match(/\d+/)?.[0]) || 0)-(Number(b.loc.match(/\d+/)?.[0]) || 0));
}

function displayRows(rows) {
  return rows.map(row=>'- '+(row.topic && !row.form && !row.ocr ? row.topic+'｜' : '')+
    (row.command ? '\`'+row.value+'\`' : row.value)+' '+(row.spans ? continuationSource(row) : ref(row))).join('\n\n');
}

export async function buildFilingDraft(selection, {report,details}, entries, warnings, sourceMap, read, translate, applicationCheck, features, operations, omissions = new Map(), sameReleaseManuals = [], launch = []) {
  const reports = new Map(report.files.map(file=>[file.path,file]));
  const pagesFor = role => details.filter(file=>reports.get(file.path)?.role === role && !omissions.has(file.path))
    .flatMap(detail=> {
      const recovered = new Map((detail.ocr?.pages ?? []).map(page=>[page.page,page]));
      return (detail.pages ?? []).map(({lines},index)=>({path:detail.path,number:index+1,
        pdf:/\.pdf$/i.test(detail.path),ocr:recovered.has(index+1),lines:recovered.get(index+1)?.lines ?? lines,
        bodyLines:role === 'manual' ? recovered.get(index+1)?.bodyLines : undefined,
        tables:recovered.get(index+1)?.tables,
        outputExamples:recovered.get(index+1)?.outputExamples}));
    });
  const forms = pagesFor('form');
  const manuals = pagesFor('manual');
  const fields = formFields(forms);
  const header = manualIdentity(manuals);
  const releases = packageFacts(details,new Map(entries.map(entry=>[entry.path,entry])));
  const release = releases.length === 1 ? releases[0] : null;
  const formalName = fields.get('软件全称');
  const formalVersion = fields.get('版本号');
  const knownName = [selection?.confirmedName,formalName?.value,selection?.softwareName,header?.name,release?.name].filter(Boolean);
  const name = knownName[0];
  const version = selection?.version ?? (versionValue(formalVersion?.value) ? 'V'+versionValue(formalVersion.value) : null) ?? header?.version ?? release?.version;
  if (!name || !version) return null;
  const ocr = crossCheckOCR([...forms,...manuals],entries,sourceMap?.files.map(file=>file.path) ?? [],read);
  const claimLocations = new Set();
  const deploymentLocations = new Set();
  const measurementFacts = new Map();
  const captions = tableCaptions(details,entries);
  const tableFacts = new Set();
  const withoutClaims = (row,value) => {
    const checked = separateManualClaims(value);
    if (checked.claims.length) claimLocations.add(tag(row));
    return checked.text.split(/(?<=[.!?])\s+/u).filter(sentence=>{
      if (!clientBehaviorClaim.test(sentence)) return true;
      deploymentLocations.add(tag(row));
      return false;
    }).join(' ').trim();
  };
  const gui = !!operations?.length && operations.every(item=>item.mode === 'gui');
  const commandReplay = !!launch.length && operations.every(item=>item.mode === 'command');
  const narration = commandReplay ? manuals.filter(page=>!sameReleaseManuals.includes(page.path) ||
    !/(?:^|\/)README(?:\.[^.]+)?$/iu.test(page.path)) : manuals;
  const continuations = manualContinuations(narration,entries).filter(row=>row.value);
  const rawRows = [...paragraphEvidence(forms,true,ocr.prose,withoutClaims),
    ...paragraphEvidence(narration,false,ocr.prose,withoutClaims,continuations,gui)].slice(0,180)
    .concat(continuations.map(row=>({...row,topic:'',ancestors:[],value:withoutClaims(row,row.value)})));
  const description = release && (!gui || canonical(release.name) === canonical(name)) ? release.description : '';
  const required = [...new Set([
    ...rawRows.flatMap(row=>[...(englishTitle(row.topic) ? [row.topic] : []),...(!row.command && english(row.value) ? [row.value] : [])]),
    ...(description && english(description) ? [description] : []),
  ])];
  const chinese = required.length ? await translate(required,[release?.name,...(release?.commands ?? [])].filter(Boolean))
    .catch(()=>new Map()) : new Map();
  const flags = versionedOptions(entries,sourceMap,read);
  const optionEvidence = new Set();
  const flagRefs = new Map();
  for (const [long,item] of flags) {
    if (!item.short) continue;
    if (!flagRefs.has(item.short)) flagRefs.set(item.short,[]);
    flagRefs.get(item.short).push({long,...item});
  }
  const rows = rawRows.flatMap(row=>{
    if (!row.command && english(row.value) && !chinese.has(row.value)) return [];
    let value = row.command ? row.value : chinese.get(row.value) ?? row.value;
    let sourceOption;
    if (!row.command && chinese.has(row.value)) {
      const pair = /(--[\w-]+)\x60?\s+or\s+\x60?(-{1,2}[\w-]+)/giu;
      for (const [,long,short] of row.value.matchAll(pair)) {
        const aliases = flagRefs.get(short);
        const samePrefix = aliases?.length === 1 && aliases[0].long.startsWith(long);
        const reference = flags.get(long) ?? (samePrefix ? aliases[0] : null);
        if (!reference) continue;
        if (!flags.has(long)) {
          value = value.replace(long,reference.long);
        } else if (short !== reference.short) {
          const index = value.indexOf(short,value.indexOf(long)+long.length);
          if (index < 0) continue;
          if (reference.short) {
            value = value.slice(0,index)+reference.short+value.slice(index+short.length);
          } else {
            const before = value.slice(0,index).replace(/\s*(?:或|或者)\s*$/u,'');
            value = before+value.slice(index+short.length);
          }
        } else continue;
        sourceOption = [sourceOption,reference.location].filter(Boolean).join('、');
        optionEvidence.add(reference.path);
      }
      const alignment = ['--left','--center','--right','--text-left','--text-center','--text-right'];
      if (alignment.every(flag=>row.value.includes('`'+flag+'`') && flags.has(flag))) {
        value = '设置输出宽度后可分别控制两层对齐。用 --left、--center、--right 将整个文本块在终端内左对齐、居中或右对齐。用 --text-left、--text-center、--text-right 设置块内文字的对齐方式。';
        sourceOption = [...new Set(alignment.map(flag=>flags.get(flag).location))].join('、');
        for (const flag of alignment) optionEvidence.add(flags.get(flag).path);
      }
    }
    if (!row.command && chinese.has(row.value)) value = withoutClaims(row,value);
    if (!value) return [];
    return [{...row, topic:englishTitle(row.topic) ? chinese.get(row.topic) ?? row.topic : row.topic,
      originalValue:row.value,
      originalTopic:row.topic,value:row.command ? value : bindTableReferences(
        attributeMeasurements(value,row,measurementFacts),row.path,captions,tableFacts),sourceOption}];
  });
  const untranslated = rawRows.filter(row=>!row.command && english(row.value) && !chinese.has(row.value));
  const releaseDescription = chinese.get(description) ?? (!english(description) ? description : '');
  const nameRow = formalName?.value === name ? formalName :
    (header?.name === name ? header : (release?.name === name ? {...release,loc:'发布清单'} : null));
  const declaredVersions = [versionValue(formalVersion?.value),versionValue(header?.version),release && versionValue(release.version)].filter(Boolean);
  const safeName = prose(name.replace(/[\r\n]/g,' '));
  const mismatch = knownName.slice(1).filter(value=>canonical(value) !== canonical(name) &&
    !(release?.name === value && canonical(name).includes(canonical(release.name))));
  const conflicts = [...new Set([
    ...mismatch.map(value=>'原件另载软件名「'+value+'」，提交前核实登记全称。'),
    ...declaredVersions.filter(value=>'V'+value !== version).map(value=>'原件另载版本 V'+value+'，提交前核实同版来源。'),
    ...warnings,
  ])];
  const roles = role => report.files.filter(file=>file.role === role).map(file=>file.path);
  const intro = title => ['# '+title,'','软件全称：'+safeName,'','版本号：'+version,''];
  const used = new Set();
  const references = rows.filter(row=>!row.form && !row.pdf &&
    row.ancestors.some(item=>referenceHeading.test(item.title)));
  const manualReferences = gui ? references.filter(row=>!row.command && sameReleaseManuals.includes(row.path)) : references;
  const referenceRows = new Set(references);
  const localizedManual = rows.filter(row=>!row.form && !row.pdf && !referenceRows.has(row) &&
    (row.command || chinese.has(row.originalValue) || /\.tex$/iu.test(row.path)));
  const heading = row => row.ancestors.filter(item=>item.level>1).map(item=>item.title).join(' ');
  const category = row => {
    const context = heading(row);
    if (!context) return row.command ? 1 : -1;
    if (sectionTypes[0][1].test(context)) return 0;
    if (sectionTypes[2][1].test(context)) return 2;
    return 1;
  };
  const structured = localizedManual.filter(row=>heading(row)).length >= 8;
  const ordinaryRows = rows.filter(row=>!row.spans && !referenceRows.has(row));
  const overview = gui ? ordinaryRows.filter(row=>!row.form && !row.command &&
    /简介|分屏预览/u.test(row.topic) && /浏览器端|分屏/u.test(row.value)).slice(0,2).map(row=>({...row,topic:'',
      value:row.value.split(/(?<=。)/u).filter(sentence=>!/使用.{0,45}实现|支持.{0,55}框架/u.test(sentence)).join('')})) :
    structured ? localizedManual.filter(row=>category(row) === -1).map(row=>({...row,topic:''})) :
    chooseRows(ordinaryRows,/用途|目的|主要功能|概述|toolbox|overview/iu,4,used,false);
  const sections = sectionTypes.map(([title,pattern],index)=>{
    const selected = gui ? index === 2 ? ordinaryRows.filter(row=>!row.form && !row.command &&
      /关于分歧|使用限制|问题排查|注意事项/u.test(row.topic)).slice(0,1) : [] :
      structured ? localizedManual.filter(row=>category(row) === index) :
      chooseRows(ordinaryRows,pattern,17,used,false,index);
    const continued = rows.filter(row=>row.section === index);
    if (continued.length) {
      selected.push(...continued);
      selected.sort((a,b)=>a.path.localeCompare(b.path) || a.number-b.number);
    }
    return [title,selected];
  });
  const feature = chooseRows([...ordinaryRows,...references],/用途|目的|主要功能|技术特点|概述|support|features|usage|render|display|format/iu,6,new Set(),true);
  const environment = ['运行软件环境','运行硬件环境','开发软件环境','开发硬件环境']
    .flatMap(label=>fields.has(label) ? ['- '+label+'：'+fields.get(label).value+' '+ref(fields.get(label))] : []);
  if (release?.environment && !fields.has('运行软件环境')) {
    environment.unshift('- 运行依赖：'+release.environment+' '+ref({...release,loc:'运行依赖字段'}));
  }
  const formRows = labels.filter(label=>!['软件全称','版本号'].includes(label)).map(label=>{
    const fact = fields.get(label);
    if (label === '源程序量' && sourceMap) {
      const original = fact ? '原件记载 '+fact.value+' '+ref(fact)+'。' : '';
      return '- 源程序量：'+original+sourceLayoutSummary(sourceMap)+'申报源程序量待按完整范围确认。';
    }
    if (fact) return '- '+label+'：'+(legalFields.has(label) ? '待本人确认。原表记载为 ' : '原件记载 ')+fact.value+' '+ref(fact);
    if (label === '运行软件环境' && release?.environment) return '- '+label+'：'+release.environment+' '+ref({...release,loc:'运行依赖字段'});
    if (label === '编程语言') {
      const languages = [...new Set(roles('source').map(path=>({py:'Python',js:'JavaScript',ts:'TypeScript',c:'C',cpp:'C++',sh:'Shell',go:'Go',rs:'Rust',java:'Java'})[path.split('.').at(-1)]).filter(Boolean))];
      if (languages.length) return '- 编程语言：已上传源码可见 '+languages.join('、')+'，请按实际范围核准。';
    }
    return '- '+label+'：待补。';
  });
  const selectedRows = gui ? overview : feature.length ? feature : rows.filter(row=>!row.command).slice(0,6);
  const operationSummary = operationDraftLines(operations,true);
  const technicalBody = [...selectedRows.map(row=>row.value),
    ...(gui || commandReplay ? operations.flatMap(item=>[item.action,...item.results]) : [])].join('\n\n');
  const form = [...intro('软件著作权登记申请表底稿'),
    '填报范围：根据本案上传材料整理。'+(selection?.confirmedName ? '软件全称由本案网页确认。' :
      nameRow ? '软件名依据 '+ref(nameRow)+'。' : '')+'请核对后填入当期在线表单。','',
    '## 申请表字段','',...formRows,'','## 主要功能与技术特点','',
    ...(releaseDescription ? ['项目描述：'+releaseDescription+' '+ref({...release,loc:'描述字段'}),''] : []),
    ...(selectedRows.length ? [displayRows(selectedRows),''] : []),
    ...(features?.names.length ? ['主要功能：'+[...new Set(features.names.map(row=>row.name))].join('、'),''] : []),
    ...(!releaseDescription && !selectedRows.length && !features?.names.length && operationSummary.length ?
      ['主要功能依据下列同版实操和结果填写。技术特点待开发方按同版源码核准。',''] : []),
    ...operationSummary,
    '功能说明提取约 '+technicalBody.replace(/\s/gu,'').length+' 字符。请结合当期表单的语言和长度要求审订。','',
    ...(conflicts.length ? ['## 版本和来源待核','',...conflicts.map(line=>'- '+line),''] : []),
    ...applicationDraftLines(applicationCheck),''].join('\n');
  const backedOperations = featureDraftLines(features).length > 0 || !!operations?.length;
  const missing = sections.filter(([title,content])=>!content.some(row=>!row.command) &&
    (title !== '环境与准备' || !environment.length && !operations?.length) &&
    !(backedOperations && ['操作步骤与示例','输出、结果与异常'].includes(title))).map(([title])=>title);
  const sourceBacked = ocr.rows;
  const preparedTables = manualTableRows(manuals.filter(page=>page.bodyLines),captions,tableFacts);
  const selectedText = sections.flatMap(([,items])=>items.map(item=>item.value)).join('\n');
  const outputSamples = [...new Set(ocr.outputs.filter(fact=>fact.value && !selectedText.includes(outputText(fact)))
    .map(fact=>'- '+outputText(fact)+'。来源为同包原件《'+fact.path+'》物理第 '+fact.page+' 页。'))];
  const manualBody = [...intro('软件说明书'),
    ...(overview.length ? ['## 软件用途','',displayRows(overview),''] : []),
    ...(commandReplay && releaseDescription && !overview.length ?
      ['## 软件用途','',releaseDescription+' '+ref({...release,loc:'发布简介'}),''] : []),
    ...launchLines(launch),
    ...(gui ? ['全尺寸截图在取件包「参考原件／实操证据」中，按下列文件名查阅。',''] : []),
    ...operationDraftLines(operations),
    ...sections.flatMap(([title,content])=>content.length || title === '环境与准备' && environment.length ?
      ['## '+title,'',...(title === '环境与准备' ? environment.flatMap(value=>[value,'']) : []),
        ...(content.length ? [displayRows(content),''] : [])] : []),
    ...(outputSamples.length ? ['## 原说明书输出示例','',...outputSamples.flatMap(line=>[line,''])] : []),
    tableSection(preparedTables),
    ...featureDraftLines(features),
    ...(sourceBacked.length ? ['## 同版源码支持的操作示例','',displayRows(sourceBacked),''] : []),
    ...(manualReferences.length ? ['## 原文档记载的功能与兼容性','',displayRows(manualReferences),''] : []),
  ].join('\n');
  const examples = [...new Set([...ocr.assignments.filter(fact=>fact.value && manualBody.includes('［字面 '+fact.id+'］')),
    ...tableExamples(preparedTables,ocr.assignments)])];
  const manual = examples.length ? manualBody+'\n## OCR 技术字面依据\n\n'+
    examples.map(fact=>'- '+exampleLine(fact)).join('\n\n')+'\n' : manualBody;
  const materialGaps = [
    ...missing.map(title=>'缺少「'+title+'」的实质证据。请补同版操作原文、截图或输入输出样例。'),
    ...(untranslated.length ? ['有 '+untranslated.length+' 段英文未取得保留技术字面的中文译文，请补经校对的中文原稿。'] : []),
    ...(ocr.findings.some(row=>row.command || row.missing.length) || ocr.assignments.some(fact=>!fact.value) ?
      ['按《OCR 命令与路径校对》补未支持的同版脚本或参数证据，并用原页核对整条命令和运行结果。'] : []),
  ];
  const checklist = [...intro('申请人补件清单'),
    applicationReport(applicationCheck).replace(/^# R3 /u,'## R3 '),
    '## 发表、完成及同版材料','',
    '请核实本版本的完成日期、发表事实和本案交存范围。案卷已有的源码、运行环境与实操证据可沿用。下方或取件清单列为待补的项目，请补与本版一致的材料。','',
    ...(claimLocations.size ? ['## R7 实操和截图来源待核','',
      ...[...claimLocations].map(location=>'- '+location+' 载有截图或输出的实操来源声明。开发方请提供同版原始截图和输出，注明对应操作步骤，交经办人核对。'),
      ''] : []),
    ...(deploymentLocations.size ? ['## 部署及数据处理声明待核','',
      ...[...deploymentLocations].map(location=>'- '+location+' 记载了数据留在浏览器或不会传给服务器的声明。请按实际部署与网络记录核实适用范围。'),
      ''] : []),
    ...(materialGaps.length ? ['## 说明书待补材料','',...materialGaps.map(line=>'- '+line),''] : []),
    ...(conflicts.length ? ['## 材料一致性待核','',...conflicts.map(line=>'- '+line),''] : []),
  ].join('\n');
  const evidencePaths = new Set([...forms.map(({path})=>path),...manuals.map(({path})=>path),...optionEvidence]);
  if (release) evidencePaths.add(release.path);
  for (const row of ocr.findings) for (const hit of row.checked) evidencePaths.add(hit.source.path);
  for (const fact of ocr.assignments) for (const hit of fact.supported) evidencePaths.add(hit.path);
  const evidence = [...new Map([
    ...entries.filter(item=>evidencePaths.has(item.path)).map(({path,hash})=>[path,{path,hash}]),
    ...(operations ?? []).flatMap(({record,proof,versionProof})=>[record,proof,proof.screenshot,versionProof]
      .filter(Boolean).map(ref=>[ref.path,{path:ref.path,hash:ref.sha256}])),
  ]).values()];
  const measurements = measurementReport([...measurementFacts.values()].filter(fact=>
    [form,manual].some(text=>text.includes('［历史记载 M'+fact.id+'］'))),entries);
  const tables = tableIndex([...tableFacts].filter(fact=>[form,manual].some(text=>
    text.includes(`［同包原件《${fact.path}》物理第 ${fact.page} 页］`))));
  return {name:safeName,version,form,manual,checklist,measurements,tables,hasBody:rows.length>0 || environment.length>0 || !!operations?.length,
    materialGaps,missing,ocrReport:ocrReport(ocr.findings,ocr.assignments,ocr.outputs),evidence,superseded:[...new Set([...forms,...manuals].map(({path})=>path))]};
}
