const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const versionValue = /^v?(\d+(?:\.\d+){1,3})$/i;
const normalizeVersion = value => typeof value === 'string' && value.match(versionValue)?.[1];
const releaseField = /^(软件版本(?:号)?\s*[:：]\s*)(v?\d+(?:\.\d+){1,3})(\s*)$/i;

function inputLines(file) {
  return file.pages?.flatMap(page=>page.lines) ?? [];
}

function oneField(lines, pattern) {
  const hits = lines.flatMap(line => line.trim().match(pattern)?.[1] ?? []);
  return hits.length === 1 ? hits[0] : '';
}

function releaseAuthority(files, report) {
  const manifests = files.filter(file=>/(?:^|\/)release\.json$/i.test(file.path));
  if (manifests.length !== 1 || !manifests[0].pages) return null;
  const [manifest] = manifests;
  let manifestData;
  try {
    manifestData = JSON.parse(inputLines(manifest).join('\n'));
  } catch {
    return null;
  }
  if (!manifestData || typeof manifestData.softwareName !== 'string') return null;
  const {softwareName, disabledFeatures} = manifestData;
  const version = normalizeVersion(manifestData.version);
  if (!version || report.target !== 'V'+version) return null;
  const folder = manifest.path.slice(0,manifest.path.lastIndexOf('/')+1);
  const versionFile = files.filter(f=>f.path === folder+'VERSION' && f.role === 'source');
  const sourceHits = report.versionEvidence.filter(hit=>hit.role==='source' && !hit.weak &&
    !hit.inTitle && hit.path.slice(0,hit.path.lastIndexOf('/')+1) === folder &&
    codePattern.test(hit.path) && hit.value === 'V'+version);
  if (versionFile.length !== 1 || normalizeVersion(inputLines(versionFile[0]).join('\n').trim()) !== version || !sourceHits.length) return null;
  const versionProof = [manifest.path+' 的 version',versionFile[0].path,sourceHits[0].path+' '+sourceHits[0].loc].join('、');
  return {softwareName, version:'V'+version, versionProof, manifestPath:manifest.path,
    disabled:Array.isArray(disabledFeatures) ? disabledFeatures.filter(feature=>typeof feature === 'string' && /^[^、，,；;。\r\n]+$/.test(feature)) : []};
}

function planDraftEdits(file, authority, manualNotes) {
  const lines = inputLines(file);
  const name = oneField(lines,/^软件全称\s*[:：]\s*(\S.{1,78})$/);
  if (name !== authority.softwareName) return [];
  const isForm = file.role === 'form';
  if (category(file.path) !== file.role) return [];
  if (isForm && !lines.includes('材料用途：内部校对')) return [];
  if (!isForm && 'V'+normalizeVersion(oneField(lines,/^构建版本\s*[:：]\s*(\S+)$/)) !== authority.version) return [];

  const [versionIndex,...otherVersions] = lines.flatMap((line,i)=>releaseField.test(line) ? [i] : []);
  const [featureIndex,...otherLists] = lines.flatMap((line,i)=>/^主要功能\s*[:：]/.test(line) ? [i] : []);
  const changes = [];
  const add = (i, after, evidence) => {
    const before = lines[i];
    if (before === after) return;
    changes.push({index:i,path:file.path,loc:/\.docx$/i.test(file.path)?'段落 '+(i+1):'第 '+(i+1)+' 行',before,after,evidence});
  };
  if (versionIndex !== undefined && !otherVersions.length) {
    const [,label,oldVersion,space] = lines[versionIndex].match(releaseField);
    add(versionIndex,label+authority.version+space,authority.versionProof);
    if (!isForm) {
      const staleHeader = name+' '+oldVersion+' 操作手册';
      const titleIndex = lines.slice(0,3).indexOf(staleHeader);
      if (titleIndex >= 0) add(titleIndex,name+' '+authority.version+' 操作手册',authority.versionProof+'；手册有同版构建标记');
    }
  }
  if (isForm && featureIndex !== undefined && !otherLists.length) {
    const list = lines[featureIndex].match(/^(主要功能\s*[:：]\s*)([^，,；;。]+)$/);
    if (list) {
      const features = list[2].split('、');
      const excluded = features.filter(feature=>authority.disabled.includes(feature) && manualNotes.has(feature));
      const kept = features.filter(feature=>!excluded.includes(feature));
      if (excluded.length && kept.length) {
        const proof = excluded.map(feature=>feature+'（'+manualNotes.get(feature)+'）').join('、');
        add(featureIndex,list[1]+kept.join('、'),authority.manifestPath+' 的 disabledFeatures；同版手册未上线记录 '+proof);
      }
    }
  }
  return changes.sort((a,b)=>a.index-b.index);
}

function editWordParagraph(paragraph, before, after) {
  if (!paragraph || paragraph.namespaceURI !== wordNamespace) return false;
  const runs = [...paragraph.children];
  if (runs.some(child=>child.namespaceURI!==wordNamespace || !['pPr','r'].includes(child.localName))) return false;
  if (runs.some(run=>run.localName==='r' && [...run.children].some(child=>
    child.namespaceURI!==wordNamespace || !['rPr','t'].includes(child.localName)))) return false;
  const nodes = [...paragraph.getElementsByTagNameNS(wordNamespace,'t')];
  if (nodes.map(node=>node.textContent).join('')!==before) return false;

  // A single text run must contain the altered range. Retain all run styling.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix]===after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length-prefix && suffix < after.length-prefix &&
    before[before.length-suffix-1]===after[after.length-suffix-1]) suffix++;
  let offset = 0;
  const end = before.length-suffix;
  for (const node of nodes) {
    const value = node.textContent;
    if (offset <= prefix && end <= offset+value.length) {
      node.textContent = value.slice(0,prefix-offset)+after.slice(prefix,after.length-suffix)+value.slice(end-offset);
      return true;
    }
    offset += value.length;
  }
  return false;
}

async function patchDraft(file, proposals) {
  if (!proposals.length) return null;
  let bytes;
  if (/\.txt$/i.test(file.path)) {
    const content = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes);
    const bom = content.startsWith('\ufeff') ? '\ufeff' : '';
    const chunks = content.slice(bom.length).split(/(\r\n|\n)/);
    for (const change of proposals) {
      if (chunks[change.index*2] !== change.before) return null;
      chunks[change.index*2] = change.after;
    }
    bytes = new TextEncoder().encode(bom+chunks.join(''));
  } else {
    const zip = await JSZip.loadAsync(file.bytes);
    const entries = Object.values(zip.files).filter(entry=>!entry.dir);
    if (entries.some(entry=>/(?:^|\/)_xmlsignatures\/|vbaProject|^EncryptedPackage$/i.test(entry.name))) return null;
    if (entries.reduce((total,entry)=>total+entry._data.uncompressedSize,0)>inputLimit) return null;
    const original = zip.file('word/document.xml');
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(await readEntry(original)),'application/xml');
    const paragraphs = [...xml.getElementsByTagNameNS('*','p')];
    // Commit a Word file only when every planned change can be represented safely.
    for (const change of proposals) {
      if (!editWordParagraph(paragraphs[change.index],change.before,change.after)) return null;
    }
    zip.file('word/document.xml',new XMLSerializer().serializeToString(xml),{date:original.date,createFolders:false});
    bytes = await zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
  }

  const edited = {path:file.path,role:file.role,bytes};
  await inspect(edited);
  const expected = inputLines(file).slice();
  for (const change of proposals) expected[change.index] = change.after;
  if (edited.hash===file.hash || JSON.stringify(inputLines(edited))!==JSON.stringify(expected)) return null;
  return {edited,changes:proposals};
}

async function autoRevise(data, before) {
  const files = new Map();
  const changes = [];
  const deferred = [];
  const authority = releaseAuthority(data.files,before);
  if (authority) {
    const manualNotes = new Map();
    const eligible = data.files.filter(file=>['manual','form'].includes(file.role) && /\.(txt|docx)$/i.test(file.path) &&
      inputLines(file).length && data.files.filter(other=>other.path===file.path).length===1);
    for (const manual of eligible.filter(file=>file.role==='manual' && category(file.path)==='manual')) {
      const rows = records(manual);
      const identity = oneField(inputLines(manual),/^软件全称\s*[:：]\s*(\S.{1,78})$/);
      const build = oneField(inputLines(manual),/^构建版本\s*[:：]\s*(\S+)$/);
      if (identity !== authority.softwareName || 'V'+normalizeVersion(build) !== authority.version) continue;
      for (const row of rows) {
        const match = row.text.match(/^本版未上线\s*[:：]\s*(.+)$/);
        if (match) manualNotes.set(match[1],manual.path+' '+row.loc);
      }
    }
    for (const file of eligible) {
      const proposals = planDraftEdits(file,authority,manualNotes);
      if (!proposals.length) continue;
      let patched;
      try {
        patched = await patchDraft(file,proposals);
      } catch (failure) {
        console.warn('未写入修订稿',file.path,failure.message);
      }
      if (!patched) {
        deferred.push(file.path+'：正文结构不支持安全写回，原件保留。');
        continue;
      }
      files.set(file,patched.edited);
      changes.push(...patched.changes);
    }
  }
  const after = files.size ? assess({...data,files:data.files.map(file=>files.get(file) ?? file)}) : before;
  return {files,changes,before,after,deferred,reason:authority ? '' : '定版记录未与 VERSION、源码的版本标记相互印证。请先确认唯一发布版本。'};
}
