import { basename } from 'node:path';
import { normalizedVersion } from './runtime-evidence.mjs';

const identityDocument = /营业执照|居民身份证|事业单位法人证书|社会团体法人登记证书|主体资格证明|身份证明/u;
const rightsDocument = /(?:(?:合作|委托|职务)?开发(?:合同|协议|任务书)|(?:著作权|软件)?(?:转让|受让|许可|授权)(?:合同|协议|证明|书)|(?:继承|承受)证明|权属证明|著作权归属协议)/u;
const signatureDocument = /(?:申请.{0,6}(?:确认|签章)|登记确认|签章页|申请人(?:签名|盖章))/u;
const history = /历史|归档|往年|登记证书|历史交存/u;
const licenseFile = /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[._-].*)?$/iu;
const legalFields = new Set(['开发方式','权利取得方式','权利范围']);
const aliases = {
  '申请主体':'申请人','申请人名称':'申请人','权利人':'著作权人','权利归属':'著作权归属',
  '本软件著作权归属':'著作权归属','签字人':'签署人','盖章单位':'签章主体',
  '签章单位':'签章主体','签署主体':'签章主体',
  '申请人(签章)':'申请人签章','申请人(签字或盖章)':'申请人签章','申请人(签名或盖章)':'申请人签章',
  '申请人签字或盖章':'申请人签章','申请人签名':'申请人签章','申请人盖章':'申请人签章',
  '软件名称':'软件全称','软件版本':'版本号','版本':'版本号',
};
const labels = new Set(['申请人','著作权人','名称','姓名','软件全称','版本号','著作权归属','受让方','被许可方',
  '申请人签章','签章','签署人','签章主体','签名','签字','公章',...legalFields]);
const signerFields = new Set(['申请人签章','签章','签署人','签章主体','签名','签字','公章']);
const normalize = value => value.normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
const softwareKey = value => normalize(value).replace(/[_.-]/gu,'');
const tidy = value => value.replace(/^\s*(?:#+\s+|[-*]\s+)?/u,'').replace(/\*\*|__|\x60/gu,'').trim();
const plausible = value => value.length <= 100 && !/@|[0-9]{15,}|身份证号|统一社会信用代码|[\[\]【】<>]/u.test(value);
const blank = value => !value || /^[［\[（(【]?\s*(?:待签(?:字|名|章)?|待盖章|待填|待确认|未签(?:字|名|章)?|未盖章|留空|签字或盖章|此处签字或盖章|_{2,}|[-—]{1,}|无)\s*[］\]）)】]?$/u.test(value);
const guideHeading = /填写说明|填表说明|填写提示|填写示例|填报指南|填表须知|参考示例|示例|样例|提交前.*(?:自查|核对)|(?:须|要|需)(?:你|本人|申请人)?(?:亲自)?确认/u;
const guideColumn = /说明|提示|建议|例[子：:]?|样例|参考|备注|填写要求|为什么|须知|选项|必填|字数/u;
const fieldColumn = /^(?:字段(?:名称)?|项目(?:名称)?|事项|表项|栏位|名称|栏目)$/u;
const valueColumn = /^(?:值|内容|填报值|(?:实际|已填|当前|本次|申报|填写|填报)(?:的)?(?:值|内容|信息|填写值|填写内容))$/u;
const cellsOf = text => text?.includes('|') ? text.replace(/^\||\|$/gu,'').split('|').map(tidy) : [];
const fieldKey = text => text.normalize('NFKC').replace(/\s+/gu,'');
const rightsChoices = {
  '开发方式':[
    ['independent',/^(?:独立|自主|自行|单独)(?:开发)?$/u],
    ['joint',/^合作(?:开发)?$/u],
    ['commissioned',/^委托(?:开发)?$/u],
    ['assigned',/^(?:(?:下达)?任务|职务)(?:开发)?$/u],
    ['modified',/^(?:二次开发|改编|修改(?:原有|已有)?软件|基于原(?:有)?软件(?:进行)?(?:修改|开发))$/u],
  ],
  '权利取得方式':[
    ['original',/^(?:原始取得|原始|自主取得)$/u],
    ['successor',/^(?:继受取得|继受)$/u],
    ['transfer',/^(?:转让|受让)(?:取得)?$/u],
    ['inherited',/^(?:继承|承受)(?:取得)?$/u],
    ['modified',/^(?:许可(?:取得)?|原权利人许可)$/u],
  ],
};
const choiceOf = (field,value) => rightsChoices[field]?.find(([,pattern])=>pattern.test(fieldKey(value).replace(/[。.]$/u,'')))?.[0];
const titles = {identity:'申请主体',rights:'权属',signature:'签章'};
export const applicationStatus = {missing:'待补',conflict:'发现冲突',review:'待人工复核'};

function documentLines(detail) {
  const pdf = /\.pdf$/iu.test(detail.path);
  const docx = /\.docx$/iu.test(detail.path);
  const recovered = new Set(detail.ocr?.pages.map(item=>item.page));
  return (detail.pages ?? []).flatMap((page,index)=>page.lines.map((raw,line)=>({
    text:tidy(raw),
    heading:/\.md$/iu.test(detail.path) ? raw.match(/^\s*(#{1,6})\s/u)?.[1].length : undefined,
    location:pdf ? '第 '+(index+1)+' 页第 '+(line+1)+' 行' :
      docx ? '第 '+(line+1)+' 段' : '第 '+(line+1)+' 行',
    ocr:recovered.has(index+1),
  })));
}

function labelled(lines) {
  let guideLevel = 0;
  let table;
  return lines.flatMap(({text,heading,...source},index)=>{
    if (heading && heading<=guideLevel) guideLevel = 0;
    if (heading && !guideLevel && guideHeading.test(text)) guideLevel = heading;
    if (guideLevel) return [];

    const cells = cellsOf(text);
    const following = lines[index+1];
    if (!cells.length) table = undefined;
    const separator = cellsOf(following?.text);
    if (cells.length>1 && separator.length===cells.length && separator.every(cell=>/^:?-{3,}:?$/u.test(cell))) {
      const keyColumn = cells.findIndex(cell=>fieldColumn.test(fieldKey(cell)));
      const valueIndex = cells.findIndex(cell=>valueColumn.test(fieldKey(cell)));
      table = {key:keyColumn<0 ? 0 : keyColumn,value:valueIndex>=0 ? valueIndex :
        cells.some(cell=>guideColumn.test(fieldKey(cell))) ? -1 : 1};
      return [];
    }
    // A table without a value column can contain field names as topics, rather than as entries.
    if (table?.value===-1) return [];
    const hit = cells.length > 1 ? cells : text.split(/[:：]/u);
    const key = fieldKey(hit[table?.key ?? 0] ?? '');
    const field = aliases[key] ?? key;
    if (!labels.has(field)) return [];
    const separate = hit.length === 1 && !source.ocr && !signerFields.has(field) && following &&
      !following.heading && !following.ocr && !/[:：|]/u.test(following.text) &&
      !labels.has(aliases[fieldKey(following.text)] ?? fieldKey(following.text));
    const value = hit.length > 1 ? (cells.length > 1 ? hit[table?.value ?? 1] ?? '' : hit.slice(1).join('：')).trim() :
      // Same-cell DOCX text can be followed by a separate value paragraph.
      (separate ? following.text : '');
    if (blank(value)) return signerFields.has(field) ? [{...source,field,value:'原件签章栏未填',empty:true}] : [];
    if (rightsChoices[field] && !choiceOf(field,value)) return [];
    const location = separate ? source.location+' 至 '+following.location : source.location;
    return plausible(value) ? [{...source,field,value,location}] : [];
  });
}

const at = hit => hit.path+' '+hit.location+(hit.ocr ? '（扫描识别，待目验）' : '');
const shown = hit => hit.field+'「'+hit.value+'」｜'+at(hit);
const currentType = (pattern,name,lines) => ({mentioned:pattern.test(name) || lines.some(line=>pattern.test(line.text)),
  inBody:lines.some(line=>pattern.test(line.text))});

function referencesIn(path,hash,lines,isLicense,isHistory,fields) {
  const make = (field,value,{location,ocr}) => ({location,ocr,path,sha256:hash,field,value});
  if (isLicense) return lines.slice(0,12).flatMap(({text,...line})=>{
    const attribution = text.replace(/\s*<[^<>\s]+@[^<>\s]+>\s*$/u,'');
    if (/^(?:Copyright\b|版权所有)/iu.test(attribution) && plausible(attribution)) {
      return [make('项目版权声明',attribution,line)];
    }
    if (/^.{0,52}Licen[cs]e(?: \([\w.-]{1,24}\))?$/iu.test(text) ||
        /^SPDX-License-Identifier:\s*[\w.-]+$/iu.test(text)) return [make('项目许可',text,line)];
    return [];
  });
  if (isHistory) return fields.filter(item=>['申请人','著作权人','著作权归属'].includes(item.field))
    .map(hit=>({...hit,field:'历史'+hit.field}));
  if (/^PKG-INFO$/iu.test(basename(path))) {
    if (/(?:^|\/)[^/]+\.egg-info\//iu.test(path) ||
        !/^Metadata-Version:\s*[12]\.\d+$/iu.test(lines[0]?.text ?? '')) return [];
    const firstBlank = lines.findIndex(line=>!line.text);
    return lines.slice(0,firstBlank<0 ? lines.length : firstBlank).flatMap(({text,...line})=>{
      const author = /^Author:\s*(.+)$/iu.exec(text)?.[1];
      if (author && plausible(author)) return [make('项目署名',author,line)];
      const license = /^License(?:-Expression)?:\s*([\w .()+-]{1,80})$/iu.exec(text)?.[1];
      if (license) return [make('发布清单许可',license,line)];
      const source = /^(?:Project-URL:\s*(?:Source|Repository),|Home-page:)\s*(https:\/\/[\w./~%-]+)$/iu.exec(text)?.[1];
      return source ? [make('项目公开来源',source,line)] : [];
    });
  }
  return lines.flatMap(({text,...line})=>{
    const author = /^authors?\s*=\s*\[?\s*\{\s*name\s*=\s*["']([^"']+)["']/u.exec(text) ??
      /^"author"\s*:\s*(?:\{\s*"name"\s*:\s*)?"([^"<]+)["<]/u.exec(text);
    const license = /^(?:license\s*=\s*|"license"\s*:\s*)["']([\w .()+-]{1,80})["']/iu.exec(text);
    const name = author?.[1].trim();
    if (name && plausible(name)) return [make('项目署名',name,line)];
    return license ? [make('发布清单许可',license[1],line)] : [];
  });
}

function rightsRequest(mode,acquisition) {
  if (mode==='commissioned') return '由委托方和开发方确认合同中的著作权归属，按适用情形提供签署完整的委托开发合同。';
  if (mode==='joint') return '由共同开发方确认权利人及份额，按适用情形提供已签署的合作开发合同。';
  if (mode==='assigned') return '由用人或下达任务的单位确认权利归属，按适用情形提供项目任务书或书面约定。';
  if (acquisition==='transfer') return '由本次申请人与原权利人提供或核验完整的权利转让合同或权利承受证明，明确版本及权利范围。';
  if (acquisition==='inherited') return '由申请人提供相应的继承或承受证明并核实承接范围。';
  if (acquisition==='successor') return '由申请人确认实际的继承、受让或承受方式，提交相应的证明并核对权利范围。';
  if (mode==='modified' || acquisition==='modified') return '由申请人与原权利人核对原软件授权、修改范围和新增部分的权属，按适用情形提供原权利人许可。';
  if (mode==='independent') return '由申请人确认独立开发及权利范围。使用了他人软件时，由申请人按适用情形提供相应依据。';
  return '由申请人确认本次权利人、开发方式、权利取得方式和权利范围，再按实际情形提供合同、任务书、原权利人许可或继受证明。';
}

export function checkApplication({report,details},versionCheck,historicalArchive) {
  const files = new Map(report.files.map(file=>[file.path,file]));
  const claims = [];
  const references = [];
  const identities = [];
  const rights = [];
  const signatures = [];
  for (const detail of details) {
    const {path} = detail;
    const name = basename(path);
    const file = files.get(path);
    const isLicense = licenseFile.test(name);
    const isManifest = /^(?:pyproject\.toml|package\.json|PKG-INFO)$/iu.test(name);
    if (!isManifest && !isLicense && (file.role === 'source' || file.role === 'manual')) continue;
    const lines = documentLines(detail);
    const heading = lines.filter(line=>line.text).slice(0,8);
    const fields = labelled(lines).map(hit=>({...hit,path,sha256:file.hash}));
    const isHistory = historicalArchive.has(path) || /历史|归档|往年/u.test(path) ||
      (/登记证书/u.test(name) && !identityDocument.test(name)) ||
      heading.some(line=>history.test(line.text) && !identityDocument.test(line.text));
    if (isLicense || isHistory || isManifest) {
      const hits = referencesIn(path,file.hash,lines,isLicense,isHistory,fields);
      references.push(...(hits.length ? hits : !isManifest ?
        [{path,sha256:file.hash,location:'上传原件',field:isHistory ? '历史材料' : '项目许可文件',value:'正文待复核'}] : []));
      continue;
    }
    const form = file.role === 'form' || heading.some(line=>/计算机软件著作权登记申请表|软件著作权登记申请表/u.test(line.text));
    if (form) claims.push(...fields);
    const record = {path,sha256:file.hash,fields};
    const identity = currentType(identityDocument,name,heading);
    const right = currentType(rightsDocument,name,heading);
    const signature = currentType(signatureDocument,name,heading);
    if (identity.mentioned || file.role === 'identity') identities.push({...record,recognized:identity.inBody});
    if (right.mentioned || file.role === 'rights') rights.push({...record,recognized:right.inBody});
    if (signature.mentioned || file.role === 'declaration' || (form && fields.some(hit=>signerFields.has(hit.field)))) {
      const visual = /\.(?:pdf|docx|png|jpe?g|webp|tiff?|heic)$/iu.test(path);
      signatures.push({...record,recognized:signature.inBody || form,visual});
    }
  }

  const pick = (fields,names) => fields.filter(hit=>names.includes(hit.field));
  const keys = hits => new Set(hits.map(hit=>normalize(hit.value)));
  const explicitApplicants = pick(claims,['申请人']);
  const declaredOwners = pick(claims,['著作权人']);
  const applicants = keys(explicitApplicants);
  const ownerKeys = keys(declaredOwners.length ? declaredOwners : explicitApplicants);
  const identityHits = identities.filter(doc=>doc.recognized)
    .flatMap(doc=>pick(doc.fields,['姓名','名称']));
  const identityNames = keys(identityHits);
  const nonApplicant = identityHits.filter(hit=>applicants.size && !applicants.has(normalize(hit.value)));
  const missingNames = [...applicants].some(name=>!identityNames.has(name));
  const applicantSets = new Map();
  for (const hit of explicitApplicants) {
    if (!applicantSets.has(hit.path)) applicantSets.set(hit.path,new Set());
    applicantSets.get(hit.path).add(normalize(hit.value));
  }
  const competingForms = [...applicantSets.values()].some(names=>names.size !== applicants.size);
  const identityConflict = competingForms || !!nonApplicant.length;
  const bothDeclared = explicitApplicants.length && declaredOwners.length;
  const separateOwner = bothDeclared && [...applicants].some(name=>!ownerKeys.has(name));
  const formSoftware = pick(claims,['软件全称']);
  const releaseNames = new Set(versionCheck.groups.release.map(hit=>softwareKey(hit.name)));
  const scopeNames = new Set(formSoftware.map(hit=>softwareKey(hit.value)));
  if (!scopeNames.size) for (const name of releaseNames) scopeNames.add(name);
  const version = versionCheck.groups.target[0]?.version ?? versionCheck.reference;
  const scope = doc => {
    const names = pick(doc.fields,['软件全称']);
    const versions = pick(doc.fields,['版本号']);
    if (names.some(hit=>scopeNames.size && !scopeNames.has(softwareKey(hit.value))) ||
        versions.some(hit=>version && normalizedVersion(hit.value) && normalizedVersion(hit.value)!==version)) return 'conflict';
    const matched = names.length && names.every(hit=>scopeNames.has(softwareKey(hit.value))) &&
      versions.length && version && versions.every(hit=>normalizedVersion(hit.value)===version);
    return matched && ![...names,...versions].some(hit=>hit.ocr) ? 'matched' : 'open';
  };

  const rightsFields = claims.filter(hit=>legalFields.has(hit.field) || hit.field==='著作权人');
  const selectedChoices = field => new Set(pick(rightsFields,[field]).map(hit=>choiceOf(field,hit.value)));
  const modes = selectedChoices('开发方式');
  const acquisitions = selectedChoices('权利取得方式');
  const conflictingFields = [modes.size>1 ? '开发方式' : '',acquisitions.size>1 ? '权利取得方式' : ''].filter(Boolean).join('、');
  const rightFiles = rights.filter(doc=>doc.recognized);
  const rightParties = doc=>pick(doc.fields,['著作权归属','著作权人','受让方','被许可方']);
  const ownership = doc=>pick(doc.fields,['著作权归属','著作权人','受让方']);
  const rightsConflict = !!conflictingFields || rightFiles.some(doc=>scope(doc)==='conflict' ||
    (ownerKeys.size && ownership(doc).some(hit=>!ownerKeys.has(normalize(hit.value)))));
  const matchedOwners = keys(rightFiles.filter(doc=>scope(doc)==='matched')
    .flatMap(doc=>ownership(doc).filter(hit=>!hit.ocr)));
  const rightsMatch = !!ownerKeys.size && [...ownerKeys].every(name=>matchedOwners.has(name));
  const signatureHits = doc=>doc.fields.filter(hit=>signerFields.has(hit.field));
  const signedFiles = signatures.filter(doc=>doc.recognized && signatureHits(doc).some(hit=>!hit.empty));
  const signatureConflict = signedFiles.some(doc=>scope(doc)==='conflict' || (applicants.size &&
    pick(doc.fields,['申请人','签章主体']).some(hit=>!applicants.has(normalize(hit.value)))));
  const signatureReview = !!signedFiles.length || signatures.some(doc=>doc.visual);
  const sample = docs=>docs.map(doc=>({path:doc.path,sha256:doc.sha256,location:'上传原件'}));
  const item = (id,status,owner,summary,next,evidence,attachments) =>
    ({id,title:titles[id],status,owner,summary,next,evidence,attachments:sample(attachments)});
  const items = [
    item('identity',identityConflict ? 'conflict' : applicants.size && !missingNames ? 'review' : 'missing',
      '申请人 / 经办人',
      competingForms ? '不同申请原件记载的申请人不一致。' : identityConflict ? '申请原件与主体证明的名称不一致。' :
        !applicants.size ? '未见载有本次申请人法定名称的申请原件。' :
        missingNames ? '已读到申请名称，尚缺各申请人对应的有效主体证明。' : '申请原件与主体证明的名称文本已对照。证明效力待核。',
      identityConflict ? '核对列出的名称，确认本次申请人及其与权利人的关系，换成与实际申请人一致的有效身份证明或更正申请表。' :
        '请申请人确认本次申请主体及法定全称。自然人提供有效身份证明，组织提供适用的主体证明。经办人逐一核对原件、有效性及与本次申请的关系。',
      [...explicitApplicants,...declaredOwners,...identityHits],identities),
    item('rights',rightsConflict ? 'conflict' : rightsMatch || rightFiles.length ? 'review' : 'missing',
      '申请人 / 相关权利方',
      conflictingFields ? '申请原件填写的'+conflictingFields+'不一致。' :
        rightsConflict ? '权属原件的权利人、软件名称或版本与申请案卷有冲突。' :
        rightsMatch ? '读到与本案软件、版本及申报权利人对应的归属文本。完整文件、实际权利及效力待核。' :
          rightFiles.length ? '收到权属文件。尚未核实与本案软件、版本、权利人及权利范围的对应关系。' :
            '未见同时能核对本次软件、权利人和权利来源的权属依据。',
      (separateOwner ? '请说明申请人与著作权人的关系，并由相关权利方核验代理或相应权利依据。' : '')+
        (conflictingFields ? '由申请人核对所列原件，确认本次的'+conflictingFields+'、更正申请表后再确定适用证明。' :
          rightsRequest(modes.values().next().value,acquisitions.values().next().value))+
        (rightsMatch ? '请核对文件全文、签署状态及权利覆盖范围。' : '')+
        (references.some(hit=>/项目许可|项目版权声明/u.test(hit.field)) ?
          '如基于现有开源项目，请说明本次所申报的自行开发部分，核对上游许可及相应权利边界。' : ''),
      [...rightsFields,...rightFiles.flatMap(doc=>[...rightParties(doc),...pick(doc.fields,['软件全称','版本号',...legalFields])])],rights),
    item('signature',signatureConflict ? 'conflict' : signatureReview ? 'review' : 'missing',
      '经办人 / 申请人',
      signatureConflict ? '签章材料记载的主体、软件名称或版本与本案有冲突。' :
        signatureReview ? '收到签章候选。已读文字或文件本身的接收情况可查，签章真实性与效力待人工复核。' :
          '未见可核的本次申请签章材料。'+(signatures.length ? '材料中有空白栏或未取得可确认的签章页。' : ''),
      '经办人从当前办理入口取得适用的表单或确认材料。由相应申请人按要求签名或盖章，交回同一主体、同一软件及同版的完整签认件。经办人目验签章真实性、权限和页内容。',
      signatures.filter(doc=>doc.recognized).flatMap(doc=>[...pick(doc.fields,['软件全称','版本号','申请人']),...signatureHits(doc)]),signatures),
  ];
  // OCR is a lead. A text match cannot certify that proof is current, complete or authentic.
  const crossRead = applicants.size && [...applicants].every(name=>identityHits.some(hit=>!hit.ocr && normalize(hit.value)===name)) &&
    ![...explicitApplicants,...declaredOwners].some(hit=>hit.ocr) && rightsMatch;
  const conflicted = items.some(result=>result.status==='conflict') || !!separateOwner;
  return {items,references,formal:crossRead && !conflicted ? 0.5 : 0};
}

export const applicationActions = check => check.items.map(item=>({id:'R3',title:item.title,owner:item.owner,detail:item.next}));

export function applicationRow(row,check,findings=[]) {
  return {...row,title:'申请主体、权属与签章',quality:findings.length ? 0 : 1,formal:findings.length ? 0 : check.formal,
    status:findings.length || check.items.some(item=>item.status==='conflict') ? '退回' : '待人工确认',
    evidence:check.items.map(item=>item.title+'：'+item.summary).join(' '),
    todo:'逐项补件及出处见《主体权属签章核对.md》。',findings};
}

export function applicationReport(check) {
  return ['# R3 申请主体、权属与签章','',
    '此件记录申请原件中的文本和材料线索。身份效力、权利归属、签章真实性及适用性须由经办人和相关当事人核验。','',
    '## 已读到的本案原件记载','',
    ...check.items.flatMap(item=>['### '+item.title,'',item.summary,'',
      ...(item.evidence.length ? item.evidence.map(hit=>'- '+shown(hit)) : ['- 未读到可列的本案原件记载。']),
      ...(item.attachments.length ? ['','收到的附件：'+item.attachments.map(hit=>hit.path).join('、')] : []),'']),
    '## 来源线索','',
    '以下历史、项目署名或许可记载仅供溯源。','',
    ...(check.references.length ? check.references.map(hit=>'- '+shown(hit)) : ['- 本案暂无单列的来源线索。']),'',
    '## 缺项与责任人','',
    ...check.items.flatMap(item=>['- '+item.title+' · '+applicationStatus[item.status]+' · '+item.owner+'。'+item.next]),
    '', '依据：[《计算机软件著作权登记办法》第十一条、第十七条](https://www.ncac.gov.cn/xxfb/flfg/bmgz/202410/t20241015_869486.html)。','',
  ].join('\n');
}

export function applicationDraftLines(check) {
  const claims = [...check.items[0].evidence.filter(hit=>['申请人','著作权人'].includes(hit.field)),
    ...check.items[1].evidence.filter(hit=>legalFields.has(hit.field))];
  return ['## 申请主体、权属与签章','','以下为原件记载，申请人与经办人核对后填写。','',
    ...['申请人','著作权人',...legalFields].map(field=>{
      const hits = claims.filter(hit=>hit.field===field);
      return '- '+field+(hits.length ? '（原件记载，待确认）：'+hits.map(hit=>'「'+hit.value+'」｜'+at(hit)).join(' / ') : '：待补。');
    }),
    ...check.items.map(item=>'- '+item.title+' · '+applicationStatus[item.status]+' · '+item.owner+'。'+item.next)];
}
