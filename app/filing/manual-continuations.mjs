// Anchors verified against the printed page edges of this exact original.
const originalHash = '78f927bc327e0b0c35c6c8e4d5e4c05c55f9edf8164b31d459ee700c6c585c40';
const continuations = [
  {before:16, section:2, start:/^表中\s*jobs_placed/u, tail:/重新[“”]\s*放$/u,
    head:/^置[”"]/u, end:/^否产生实际效果.*。$/u},
  {before:7, section:1, start:/^6\.\s*每个调度点/u, tail:/成批放置；否$/u,
    head:/^则直接返回/u, end:/^则直接返回，不取全局锁。$/u},
  {before:12, section:1, start:/^就绪池保存所有/u, tail:/512\s*次唤醒的负载下，这$/u,
    head:/^种扫描发生了/u, end:/^种扫描发生了.*。$/u},
  {before:17, section:2, start:/^为了让结果可被第三方复核/u, tail:/不跨批次比较；$/u,
    head:/^2\.\s*重复与统计量/u, end:/^满足使用条件。$/u},
];

const contentLines = page => (page?.bodyLines ?? page?.lines ?? []).flatMap((source,index) => {
  const line = source.trim();
  return line && !/^(?:Yat-CAShed\s+.*V1\.0(?:\s*软件说明书)?|软件说明书|第\s*\d+\s*页\s*\/\s*共\s*\d+\s*页)$/u.test(line)
    ? [{line,index}] : [];
});
const compact = text => text.normalize('NFKC').replace(/\s+/gu,'');

export function manualContinuations(pages, entries) {
  return entries.filter(entry=>entry.hash === originalHash).flatMap(({path})=>{
    const source = new Map(pages.filter(page=>page.path === path && page.ocr).map(page=>[page.number,page]));
    return continuations.map(({before,section,start,tail,head,end})=>{
      const number = before+1;
      const row = {path,number,loc:`第 ${before}–${number} 页`,section,pdf:true,ocr:true};
      const left = contentLines(source.get(before));
      const right = contentLines(source.get(number));
      const from = left.findIndex(({line})=>start.test(line));
      const to = right.findIndex(({line})=>end.test(line));
      if (from < 0 || to < 0 || !tail.test(left.at(-1).line) || !head.test(right[0].line)) return row;
      const spans = [[before,left.slice(from)],[number,right.slice(0,to+1)]];
      const value = spans.flatMap(([,lines])=>lines.map(({line})=>line)).join(' ')
        .replace(/(重新|所有)”\s*/gu,'$1“')
        .replace(/(?<=[\p{Script=Han}“])[ \t]+(?=[\p{Script=Han}，。；：！？])/gu,'');
      return {...row,value,spans};
    });
  });
}

export function missingManualContinuations(rows, text) {
  const actual = compact(text).replace(/\[历史记载M\d+\]原件记载\(本次未复测\),/gu,'');
  return rows.filter(row=>!row.value || !actual.includes(compact(`${row.value} ${continuationSource(row)}`)));
}

export const continuationSource = row => `来源为同包原件《${row.path}》物理${row.loc}（OCR 待校）。`;
