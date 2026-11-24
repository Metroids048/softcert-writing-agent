import { bindTableReferences } from './table-references.mjs';

const tableCaption = /^\s*(表\s*\d+(?:[.-]\d+)*)\s*[:：]\s*(\S.*)$/u;
const measured = /实测值|实测结果|版本间.*对比/u;
const section = '原说明书表格与操作参考';
const normalized = text => text.normalize('NFKC').replace(/\s+/gu,'');
const displayCell = text => text.replace(/(?<=[\p{Script=Han}，。；：、]) +(?=\p{Script=Han}|[，。；：、])/gu,'');

export function manualTableRows(pages, captions, used) {
  return pages.flatMap(page=>{
    const tables = new Map((page.tables ?? []).map(table=>[normalized(table.caption.match(tableCaption)[1]),table]));
    return captions.filter(item=>item.path === page.path && item.page === page.number && item.key.startsWith('表'))
      .map(item=>{
        const title = bindTableReferences(item.key,page.path,captions,used);
        const table = tables.get(item.key);
        if (!table) return {title, heading:item.title, cells:[], note:'表格行列关系待核，请查看同包原页。'};
        if ([item.title,...table.headings].some(label=>measured.test(label))) {
          return {title,heading:item.title,cells:[],note:'读数见原表，属于原件记录，本次未复测。'};
        }
        const columns = table.headings.map((heading,index)=>({heading,index}))
          .filter(({heading})=>!/中位数/u.test(heading));
        const cells = table.rows.map(row=>columns.map(({heading,index})=>
          displayCell(heading)+' '+displayCell(row[index])).join('｜'));
        const note = columns.length < table.headings.length ? '中位数读数见原表，本次未复测。' : '';
        return {title,heading:item.title,cells,note};
      });
  });
}

export function tableSection(tables) {
  if (!tables.length) return '';
  return ['## '+section,'',
    '各行按原页列位摘录。命令、参数和判读条件均为原说明书记载，实际结果待同版验证。','',
    ...tables.flatMap(({title,heading,cells,note})=>['### '+title+' · '+heading,'',
      ...(note ? [note,''] : []),...cells.flatMap(row=>['- '+row,''])]),
  ].join('\n');
}

export function tableExamples(tables, facts) {
  return facts.filter(fact=>fact.value && tables.some(table=>table.title.includes('《'+fact.original+
    '》物理第 '+fact.page+' 页') && table.cells.some(row=>row.includes(fact.key+'='+fact.value))));
}

export function verifyManualTables(tables, text) {
  const expected = tableSection(tables);
  if (!expected) return {text,valid:true};
  const stripMarkup = text => normalized(text.replace(/^(?:#{1,3}|-) /gmu,''));
  const start = text.indexOf(section);
  const end = start < 0 ? -1 : text.slice(start).search(/\n(?:## )?(?:同版源码支持的操作示例|OCR 技术字面依据|待核与待补)/u);
  const block = start < 0 ? '' : text.slice(start,end < 0 ? undefined : start+end);
  const narrative = start < 0 ? text : text.slice(0,start)+'\n'+(end < 0 ? '' : text.slice(start+end));
  return {text:narrative,valid:stripMarkup(block) === stripMarkup(expected)};
}
