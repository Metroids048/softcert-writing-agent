const normalize = value => value.trim().replace(/[ \t]+/g, ' ');

function sourceVersion(report, document, detail) {
  const hit = report.versionEvidence.find(item=>item.path === document.path && !item.weak);
  if (hit) return hit;
  const line = detail?.pages?.[0]?.lines[0]?.trim();
  const header = line?.match(/^.{2,100}\s+V(\d+(?:\.\d+){1,3})\s+(?:第\s*)?\d+\s*(?:\/\s*\d+|页)$/iu);
  return header && {loc:'第 1 页页眉',value:'V'+header[1]};
}

function conflictingLines(pages, originals) {
  const rows = pages.flatMap(page=>page.lines.map(line=>({line:normalize(line),page:page.label})));
  const conflicts = [];
  let source;
  for (const [index,{line,page}] of rows.entries()) {
    const marker = line.match(/^(?:\/\*|\/\/|#|--)?\s*={4,}\s*(?:文件\s*[:：]\s*)?([^=]+\.[a-z\d]{1,12})\s*={4,}\s*(?:\*\/)?$/iu);
    if (marker) {
      source = originals.get(marker[1].trim());
      continue;
    }
    if (!source || !/^[\x20-\x7e]{12,240}$/.test(line) || /^(?:\/\/|\/\*|\*|#|--)/.test(line)) continue;
    const previous = rows[index-1]?.line;
    const next = rows[index+1]?.line;
    if (!previous || !next || previous.length < 8 || next.length < 8) continue;
    const anchors = source.positions.get(previous) ?? [];
    const matches = anchors.filter(start=>source.lines[start+2] === next);
    if (matches.length !== 1) continue;
    const position = matches[0]+1;
    const actual = source.lines[position];
    if (line === actual || !/^[\x20-\x7e]{12,240}$/.test(actual)) continue;
    // Word-only changes with matching punctuation and two adjacent source anchors.
    const shape = value => value.replace(/[A-Za-z0-9_ \t]+/g, '');
    const words = value => value.match(/[A-Za-z0-9_]+/g) ?? [];
    const shown = words(line);
    const uploaded = words(actual);
    if (shape(line) !== shape(actual) || shown.length < 4 ||
        shown[0] !== uploaded[0] || shown.at(-1) !== uploaded.at(-1) || shown.join(' ') === uploaded.join(' ')) continue;
    conflicts.push({location:page,sourcePath:source.path,sourceLine:position+1,pdfText:line,uploadedText:actual,
      detail:'源码版本不符（正文对不上）。册中「'+line+'」，上传源码 '+source.path+' 第 '+(position+1)+' 行为「'+actual+'」。请用同版源码重出交存册，或上传生成这份册子的固定版本。'});
    if (conflicts.length === 12) break;
  }
  return conflicts;
}

export function checkSourceBooklets({report,details}, target, booklets) {
  if (!booklets.length) return [];
  const byPath = new Map(details.map(item=>[item.path,item]));
  const originals = new Map();
  for (const item of report.files) {
    if (item.role !== 'source' || /\.(?:pdf|docx)$/i.test(item.path)) continue;
    const pages = byPath.get(item.path)?.pages;
    if (!pages?.length) continue;
    const lines = pages[0].lines.map(normalize);
    const positions = new Map();
    for (const [index,line] of lines.entries()) {
      if (line.length < 8) continue;
      if (!positions.has(line)) positions.set(line,[]);
      positions.get(line).push(index);
    }
    originals.set(item.path,{path:item.path,lines,positions});
  }
  const version = target?.version || report.target;
  return booklets.flatMap(document=>{
    const detail = byPath.get(document.path);
    const declared = sourceVersion(report,document,detail);
    const hits = conflictingLines(detail?.pages ?? [],originals);
    if (version && declared && version !== declared.value) hits.unshift({
      location:declared.loc,
      detail:'源码版本不符（页眉或版本字段）。册中为 '+declared.value+'，本案核对版本为 '+version+'。请核对同版交存材料。',
    });
    return hits.map(hit=>({...hit,path:document.path}));
  });
}
