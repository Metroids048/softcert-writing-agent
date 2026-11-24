const ruleSources = [
  ['国家版权局《计算机软件著作权登记办法》', 'https://www.ncac.gov.cn/xxfb/flfg/bmgz/202410/t20241015_869486.html'],
  ['中国版权保护中心通知及新版申请表对照', 'https://ssia.org.cn/page123?article_id=2588'],
];

const roles = {
  form: '申请表', source: '源程序', manual: '软件文档', shot: '截图',
  identity: '身份证明', rights: '权属证明', declaration: '签章或承诺', other: '其他',
};
const codePattern = /\.(?:py|js|jsx|ts|tsx|go|rs|java|kt|cs|c|cpp|h|swift|rb|php|vue|svelte|sql|sh)$/i;
const imagePattern = /\.(?:png|jpe?g|webp)$/i;
const hiddenPath = /(?:^|\/)(?:\.[^/]+|__MACOSX|node_modules|__pycache__|id_rsa|id_ed25519)(?:\/|$)|\.(?:pem|key|pfx|p12|keystore)$/i;
const currentVersion = '0.1.0';
const inputLimit = 48 * 1024 * 1024;
const itemLimit = 180;

function category(path) {
  const name = path.split('/').at(-1);
  if (/签章|承诺|declaration|signed.form/i.test(name)) return 'declaration';
  if (/身份证|营业执照|身份证明|主体证明|business.licen[cs]e/i.test(name)) return 'identity';
  if (/证书|补正|权属|授权|合同|COPYING|LICEN[CS]E/i.test(name)) return 'rights';
  if (/申请表|application.form/i.test(name)) return 'form';
  if (codePattern.test(name) || /源程序|源代码|^VERSION(?:\.txt)?$|^package\.json$/i.test(name)) return 'source';
  if (/说明书|用户手册|操作手册|设计说明|^README|(^|[-_ ])manual/i.test(name)) return 'manual';
  if (imagePattern.test(name)) return 'shot';
  return 'other';
}

let pdfModule;
async function pdfApi() {
  if (pdfModule) return pdfModule;
  const moduleUrl = URL.createObjectURL(new Blob([document.getElementById('pdf-module').textContent], {type:'text/javascript'}));
  const workerUrl = URL.createObjectURL(new Blob([document.getElementById('pdf-worker').textContent], {type:'text/javascript'}));
  pdfModule = import(moduleUrl).then(api => {
    api.GlobalWorkerOptions.workerSrc = workerUrl;
    return api;
  });
  return pdfModule;
}

async function readPdf(bytes) {
  const api = await pdfApi();
  const task = api.getDocument({data:bytes.slice(), isEvalSupported:false, useSystemFonts:false, disableFontFace:true, enableXfa:false});
  try {
    const doc = await task.promise;
    const pages = [];
    let blank = 0;
    let a4 = true;
    for (let index=1; index<=Math.min(doc.numPages,100); index++) {
      const page = await doc.getPage(index);
      const size = page.getViewport({scale:1});
      const [width,height] = [size.width,size.height].sort((a,b)=>a-b);
      a4 &&= Math.abs(width-595.28)<3 && Math.abs(height-841.89)<3;
      const text = await page.getTextContent();
      const lines = [];
      let lastY;
      let line = [];
      for (const item of text.items) {
        if (!item.str) continue;
        const y = item.transform[5];
        if (lastY!==undefined && Math.abs(lastY-y)>2) {
          lines.push(line.join(' '));
          line = [];
        }
        line.push(item.str);
        lastY = y;
        if (item.hasEOL) {
          lines.push(line.join(' '));
          line = [];
          lastY = undefined;
        }
      }
      if (line.length) lines.push(line.join(' '));
      if (!lines.join('').trim()) blank++;
      pages.push({label: '第 '+index+' 页', lines});
    }
    return {pages, pageCount:doc.numPages, a4, blank, truncated:doc.numPages>pages.length};
  } finally {
    await task.destroy();
  }
}

async function readDocx(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const document = zip.file('word/document.xml');
  if (!document || document._data.uncompressedSize>3*1024*1024) throw new Error('DOCX 正文无法读入');
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(await readEntry(document)),'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('DOCX 正文无法解析');
  const paragraphs = [...xml.getElementsByTagNameNS('*','p')];
  return {pages:[{lines:paragraphs.map(p => [...p.getElementsByTagNameNS('*','t')].map(t=>t.textContent).join(''))}]};
}

function readEntry(entry) {
  const expected = entry._data.uncompressedSize;
  const buffer = new Uint8Array(expected);
  return new Promise((resolve,reject)=>{
    let offset = 0;
    const stream = entry.internalStream('uint8array');
    stream.on('data', chunk=>{
      if (offset+chunk.length>expected) {
        stream.pause();
        reject(new Error('有文件的解包长度超出记录。'));
        return;
      }
      buffer.set(chunk,offset);
      offset += chunk.length;
    });
    stream.on('error',reject);
    stream.on('end',()=>{
      if (offset!==expected) reject(new Error('有文件的解包长度与记录不一致。'));
      else resolve(buffer);
    });
    stream.resume();
  });
}

async function inspect(file) {
  file.hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',file.bytes)), b=>b.toString(16).padStart(2,'0')).join('');
  try {
    if (/\.pdf$/i.test(file.path)) {
      Object.assign(file,await readPdf(file.bytes));
      return;
    }
    if (/\.docx$/i.test(file.path)) {
      Object.assign(file,await readDocx(file.bytes));
      return;
    }
    if (imagePattern.test(file.path)) {
      const bitmap = await createImageBitmap(new Blob([file.bytes]));
      file.image = [bitmap.width,bitmap.height];
      bitmap.close();
      return;
    }
    if (/\.(?:txt|md|json|csv|ya?ml)$/i.test(file.path) || /(?:^|\/)VERSION$/i.test(file.path) || codePattern.test(file.path)) {
      const text = new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);
      file.pages = [{lines:text.split(/\r?\n/)}];
      return;
    }
    file.unreadable = '未支持正文读取';
  } catch {
    file.unreadable = '内容无法读取，请换可打开的文件或补一份可检索副本';
  }
}

async function unpack(input) {
  if (input.reduce((sum,file)=>sum+file.size,0)>inputLimit) throw new Error('单次最多选择 48 MB。请分案处理或精简附件。');
  const candidates = [];
  const skipped = [];
  let total = 0;
  function add(path, size, read) {
    if (hiddenPath.test(path)) {
      skipped.push({path, reason:'跳过隐藏文件、依赖或凭据文件'});
      return;
    }
    total += size;
    if (total>inputLimit || candidates.length>=itemLimit) throw new Error('解包超过 48 MB 或 180 个文件。请缩小案卷。');
    candidates.push({path, read, size});
  }
  for (const file of input) {
    if (/\.zip$/i.test(file.name)) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const name = entry.unsafeOriginalName ?? entry.name;
        if (name.split(/[\\/]/).includes('..') || /^[\\/]|^[a-z]:/i.test(name)) {
          skipped.push({path:entry.name,reason:'跳过不规范的 ZIP 路径'});
          continue;
        }
        if (/\.zip$/i.test(name)) {
          skipped.push({path:name,reason:'嵌套 ZIP 请拆开后单独添加'});
          continue;
        }
        add(name,entry._data.uncompressedSize,()=>readEntry(entry));
      }
    } else {
      add(file.webkitRelativePath || file.name,file.size,async()=>new Uint8Array(await file.arrayBuffer()));
    }
  }
  let actualBytes = 0;
  const files = [];
  const seen = new Map();
  for (const candidate of candidates) {
    const bytes = await candidate.read();
    actualBytes += bytes.length;
    if (actualBytes>inputLimit || candidate.size!==bytes.length) throw new Error('有文件体积与压缩包记录不一致。');
    const file = {path:candidate.path,bytes,role:category(candidate.path)};
    await inspect(file);
    const similar = seen.get(file.hash);
    if (similar && similar.role===file.role) {
      skipped.push({path:file.path,reason:'内容完全重复，已归入 '+similar.path});
      continue;
    }
    seen.set(file.hash,file);
    files.push(file);
  }
  if (!files.length) throw new Error('没有可处理的文件。请添加源码、手册、申请表或原件 ZIP。');
  return {files,skipped,originalCount:candidates.length};
}

function records(file) {
  return (file.pages ?? []).flatMap(page=>page.lines.map((text,index)=>({
    path:file.path, loc:page.label ? page.label : /\.docx$/i.test(file.path) ? '段落 '+(index+1) : '第 '+(index+1)+' 行',
    text:text.trim().replace(/\s+/g,' '),
  })));
}
function versionHits(file, lines) {
  const header = lines.slice(0, /\.pdf$/i.test(file.path) ? lines.length : 120);
  let titleHit;
  for (const row of header) {
    const known = row.text.match(/(?:软件版本(?:号)?|版本号?|__version__|APP_VERSION|["']version["'])\s*[:：=]\s*["']?v?(\d+(?:\.\d+){1,3})(?![\d.])/i);
    const title = row.text.match(/(?:软件|系统|助手)\s*V\s*(\d+(?:\.\d+){1,3})(?![\d.])/i);
    const filename = /(?:^|\/)VERSION(?:\.txt)?$/i.test(file.path) ? row.text.match(/^v?(\d+(?:\.\d+){1,3})$/i) : null;
    const found = known || filename;
    if (found) return {path:row.path,loc:row.loc,value:'V'+found[1]};
    if (title && !titleHit) titleHit = {path:row.path,loc:row.loc,value:'V'+title[1],inTitle:true};
  }
  if (titleHit) return titleHit;
  const name = file.path.split('/').at(-1).match(/(?:^|[\s_（(-])v(\d+(?:\.\d+){1,3})(?=[\s_）).-]|$)/i);
  return name ? {path:file.path,loc:'文件名（待核正文）',value:'V'+name[1],weak:true} : null;
}

function softwareName(lines) {
  for (const row of lines.slice(0,100)) {
    const hit = row.text.match(/^(?:软件全称|软件名称)\s*[:：]\s*(\S.{1,78})$/);
    if (hit) return {path:row.path,loc:row.loc,value:hit[1].trim()};
  }
  return null;
}

function assess({files,skipped,originalCount}) {
  const groups = Object.fromEntries(Object.keys(roles).map(key=>[key,files.filter(f=>f.role===key)]));
  const indexed = new Map(files.map(f=>[f,records(f)]));
  const important = [...groups.form,...groups.source,...groups.manual];
  const versionEvidence = important.flatMap(file=>{
    const hit = versionHits(file,indexed.get(file));
    return hit ? [{...hit,role:file.role}] : [];
  });
  const nameEvidence = important.flatMap(file=>{
    const hit = softwareName(indexed.get(file));
    return hit ? [{...hit,role:file.role}] : [];
  });
  const sourceFiles = groups.source.filter(f=>codePattern.test(f.path) && f.pages);
  const sourceMetaPaths = new Set([...sourceFiles,...groups.source.filter(f=>/(?:^|\/)(?:VERSION(?:\.txt)?|package\.json)$/i.test(f.path))].map(f=>f.path));
  const sourceVersions = [...new Set(versionEvidence.filter(h=>h.role==='source'&&!h.weak&&!h.inTitle&&sourceMetaPaths.has(h.path)).map(h=>h.value))];
  const target = sourceVersions.length===1 ? sourceVersions[0] : '';
  const strong = versionEvidence.filter(h=>!h.weak);
  const versions = [...new Set(strong.map(h=>h.value))];
  const names = [...new Set(nameEvidence.map(h=>h.value))];
  const versionConflict = versions.length>1;
  const nameConflict = names.length>1;
  const claims = groups.form.flatMap(file=> indexed.get(file).flatMap(row=>{
    const found = row.text.match(/^(?:软件主要功能|主要功能)\s*[:：]\s*(.+)$/);
    return found ? found[1].split(/[、，,；;。]/).map(s=>s.trim()).filter(s=>s.length>=2&&s.length<=28).map(value=>({...row,value})) : [];
  }));
  const matches = claims.slice(0,15).map(claim=>{
    const evidence = ['manual','source'].flatMap(key=>{
      for (const f of groups[key]) {
        const hit = indexed.get(f).find(row=>row.text.includes(claim.value));
        if (hit) return [{path:hit.path,loc:hit.loc,role:key}];
      }
      return [];
    });
    return {claim:claim.value,path:claim.path,loc:claim.loc,evidence};
  });
  const gaps = matches.filter(m=>m.evidence.length<2);
  const sourcePdfs = groups.source.filter(f=>f.pageCount);
  const readableManuals = groups.manual.filter(f=>f.pages?.some(p=>p.lines.some(line=>line.trim())));
  const pdfs = important.filter(f=>f.pageCount);
  const limited = important.filter(f=>f.unreadable || f.blank || f.truncated);
  const nonA4 = pdfs.filter(f=>!f.a4);
  const sourceIndex = sourceFiles.map(f=>({文件:f.path,行数:f.pages[0].lines.length,指纹:f.hash}));
  const actions = [];
  const rows = [];
  function addAction(id, priority, owner, title, detail) {
    actions.push({id,priority,owner,title,detail});
  }
  function row(id, title, quality, formal, evidence, todo) {
    rows.push({id,title,quality,formal,evidence,todo});
  }

  const missing = ['form','source','manual'].filter(key=>!groups[key].length).map(key=>roles[key]);
  const missingText = missing.length ? '本次缺 '+missing.join('、')+'。' : '已识别申请表、源程序和软件文档。';
  if (missing.length) addAction('R1','优先','经办人','补主要文件',missingText);
  if (!groups.identity.length) addAction('R1','优先','申请人','补申请主体身份证明','按实际入口提供有效身份证明，文件交由申请人自行保管。');
  row('R1','案卷齐全',1,important.length&&!missing.length?.5:0,missingText+' 已定位 '+files.length+' 个文件。','核对本次身份附件、统一表单和适用证明。');

  if (versionConflict) {
    const different = target ? strong.filter(h=>h.value!==target) : strong;
    const detail = different.slice(0,10).map(h=>h.path+' '+h.loc+' '+h.value).join('；');
    addAction('R2','优先','开发方 / 经办人','处理版本冲突',target ? '源码标记 '+target+'。请核对并替换以下异版材料。'+detail : '版本证据互相冲突。先确认定版。'+detail);
  }
  if (nameConflict) addAction('R2','优先','经办人','核对软件全称',nameEvidence.slice(0,10).map(h=>h.path+' '+h.loc+' '+h.value).join('；'));
  const allVersions = ['form','source','manual'].every(role=>strong.some(h=>h.role===role));
  if (!allVersions) addAction('R2','复核','经办人','补可读的版本证据','申请表、源程序和文档逐份确认软件名称与版本。扫描页可另备检索副本。');
  row('R2','名称和版本一致',allVersions&&!versionConflict&&!nameConflict?1:(versionEvidence.length?.5:0),
    versionConflict||nameConflict ? 0 : (allVersions||strong.length ? .5 : 0),
    strong.length ? '读到 '+strong.length+' 处正文版本证据'+(versionConflict?'，存在冲突。':'。') : '暂未读到正文版本。',
    '经办人核全称、版本、功能、环境和主体字段。');

  addAction('R3','人工确认','申请人','签章与权属核验',groups.rights.length
    ? '已发现 '+groups.rights.length+' 个权属或历史附件。请核实适用范围、受权主体与签章，并按需补证明。'
    : '请确认独立开发、合作或委托等权利来源，按适用情形补证明并签章。');
  row('R3','权属和签章真实',1,groups.rights.length||groups.identity.length||groups.declaration.length?.5:0,
    '权属或历史附件 '+groups.rights.length+' 件，身份候选 '+groups.identity.length+' 件，签章或承诺候选 '+groups.declaration.length+' 件。',
    '申请人核实主体、权利来源、相关证明与签章真伪。');

  if (!sourceFiles.length || !target) addAction('R4','优先','开发方','补同版冻结的开发源码',sourceFiles.length
    ? '已读到开发源文件，但未找到唯一的源码版本标记。请补对应发布记录、构建或已冻结版本。'
    : '需要可追溯的源码和相应构建。历史交存 PDF 只能证明交存副本。');
  else addAction('R4','复核','开发方','核定交存范围和分页','依冻结源码与完整文档检视页数、行数、顺序及适用例外。');
  row('R4','源程序可追溯及交存分页',sourceFiles.length?1:(sourcePdfs.length?.5:0),groups.source.length?.5:0,
    '已索引 '+sourceFiles.length+' 个开发源文件，识别 '+sourcePdfs.length+' 份源程序 PDF。','固定同版完整源码，逐项确认最终交存页。');

  for (const gap of gaps) {
    const present = gap.evidence.map(h=>roles[h.role]).join('、');
    addAction('R5','复核','产品 / 开发','找「'+gap.claim+'」的同版依据',
      gap.path+' '+gap.loc+(present?'。准确词语仅定位到'+present+'。':'。当前未定位同词依据。')+' 请确认是否为同义描述，核实后补文档页、源码位置或运行证据。');
  }
  if (!matches.length) addAction('R5','复核','产品 / 开发','逐项对照主要功能','当前未取出可自动对照的功能项。请用同版文档、截图和运行结果核对。');
  row('R5','软件文档解释实际功能',readableManuals.length?.5:0,
    readableManuals.length&&!versionConflict?.5:0,
    matches.length?'对照 '+matches.length+' 项功能词，'+(matches.length-gaps.length)+' 项同时定位到说明书和源码。':'可读软件文档 '+readableManuals.length+' 份，待核功能证据。',
    '词语命中仅提供位置，须复走同版界面、核图文和实际结果。');

  for (const file of nonA4.slice(0,15)) addAction('R6','复核','经办人','检查 A4 页面',file.path+' 存在非 A4 页面，请核对最终上传版本。');
  for (const file of limited.slice(0,15)) addAction('R6','复核','经办人','复核未读页或文件',file.path+'。'+(file.unreadable || (file.blank ? file.blank+' 页未提取到文本。' : '已读取前 100 页。')));
  row('R6','终件可打开和阅读',important.length ? (limited.length||nonA4.length?.5:1) : 0,pdfs.length&&!nonA4.length?.5:0,
    '检查 '+pdfs.length+' 份关键 PDF 的页面规格，'+limited.length+' 份关键文件存在未读内容。',
    '逐页检查正文、截图、页码、目录与实际入口的格式、大小。');

  addAction('R7','人工确认','申请人','按实际来源核对当期承诺','逐项核实开发、文档及申请材料来源。从实际入口取得当期表单，并由申请人如实签认。');
  row('R7','来源和承诺可确认',1,0,'归类文件记录路径和指纹。内部报告标明用途。','当前未核验申请人签认和来源承诺，提交状态保持未放行。');

  const sourcePages = sourcePdfs.map(f=>({path:f.path,pageCount:f.pageCount,
    pages:f.pages.map(p=>({loc:p.label,textLines:p.lines.filter(line=>line.trim()).length})),
  }));
  return {version:currentVersion,rows,actions,versionEvidence,nameEvidence,matches,sourceIndex,sourcePages,skipped,originalCount,
    quality:score(rows,'quality'),formal:score(rows,'formal'),target,
    files:files.map(f=>({path:f.path,role:f.role,hash:f.hash,size:f.bytes.length,pageCount:f.pageCount,
      a4:f.a4,blank:f.blank,unreadable:f.unreadable,truncated:f.truncated,image:f.image})),
  };
}
function score(rows,key) {
  return Math.round(rows.reduce((n,r)=>n+r[key],0)/rows.length*1000)/10;
}
