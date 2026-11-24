const numbered = /([表图])\s*(\d+(?:[.-]\d+)*)(?![\d.-]|\s*(?:条|次|毫秒|个|位|字节|行|项|像素))/gu;
const caption = /^\s*([表图])\s*(\d+(?:[.-]\d+)*)\s*[:：]\s*(\S.*)$/u;
const normalize = value => value.normalize('NFKC').replace(/\s+/gu,'');
const link = /［同包原件《([^》\n]+)》物理第 (\d+) 页］/gu;
const pending = '［原件图表位置待核］';

export function tableCaptions(details, entries) {
  const byPath = new Map(entries.map(entry=>[entry.path,entry.hash]));
  return details.filter(detail=>byPath.has(detail.path) && /\.pdf$/iu.test(detail.path)).flatMap(detail=>{
    const scans = new Map((detail.ocr?.pages ?? []).map(page=>[page.page,page]));
    return (detail.pages ?? []).flatMap(({lines},index)=>{
      const page = index+1;
      const scan = scans.get(page);
      const captions = new Map();
      for (const text of [...(scan?.captions ?? []),...lines,...(scan?.lines ?? [])]) {
        const hit = text.normalize('NFKC').match(caption);
        if (!hit) continue;
        const key = hit[1]+hit[2];
        if (!captions.has(key)) captions.set(key,{key,page,path:detail.path,hash:byPath.get(detail.path),title:hit[3].trim()});
      }
      return [...captions.values()];
    });
  });
}

export function bindTableReferences(text, sourcePath, targets, used) {
  return text.replace(numbered,(label,type,number,at)=>{
    // A caption describes its own object and may also be selected as source text.
    if (!text.slice(0,at).trim() && /^\s*[:：]/u.test(text.slice(at+label.length))) return label;
    const matches = targets.filter(target=>target.path === sourcePath && target.key === type+number);
    if (matches.length !== 1) return label+pending;
    const [target] = matches;
    used.add(target);
    return label+`［同包原件《${target.path}》物理第 ${target.page} 页］`;
  });
}

const indexRow = target => `- ${target.key} · 《${target.path}》物理第 ${target.page} 页 · ${target.title} · SHA-256 ${target.hash}`;

export function tableIndex(targets) {
  return targets.length ? ['# 图表引用索引','','正文标注物理页。包内路径及原件指纹见输入清单。原表所载读数保留其历史归属。','',
    ...targets.map(indexRow),''].join('\n') : '';
}

export function withoutTableReferences(text) {
  return text.replace(link,'').replaceAll(pending,'');
}

export function unverifiedTableReferences(text, report, targets) {
  const actual = normalize(text);
  return [...actual.matchAll(numbered)].flatMap(match=>{
    const [label,type,number] = match;
    const suffix = actual.slice(match.index+label.length);
    if (/^:/u.test(suffix)) return [];
    const hit = suffix.match(/^\[同包原件《([^》]+)》物理第(\d+)页\]/u);
    const group = hit && targets.filter(target=>normalize(target.path) === hit[1] && target.key === type+number);
    if (group?.length === 1 && group[0].page === Number(hit[2]) && report.split('\n').includes(indexRow(group[0]))) return [];
    return [label];
  });
}
