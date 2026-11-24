// Ordinary deposit formatting. Presence of figures, completeness, and rights need separate confirmation.
const compact = text => normalizeChinese(text).normalize('NFKC').replace(/\s/gu,'');
// Some PDF fonts expose CJK radicals in their Unicode maps. Simplified
// radicals without a Unicode compatibility mapping need an explicit alias.
export const normalizeChinese = value => value.normalize('NFC').replace(/[⺀-⿕]/gu,char=>
  ({'⻆':'角','⻚':'页','⻔':'门','⻋':'车','⻓':'长'})[char] ?? char.normalize('NFKC'));
const sameVersion = (header, version) => {
  const expected = version?.trim().replace(/^[Vv]\s*/u,'');
  const versions = [...header.normalize('NFKC').matchAll(/(?:[Vv]\s*|(?:^|[^\w.]))(\d+(?:\.\d+){1,3})(?![\d.])/gu)];
  return Boolean(expected && versions.some(match=>match[1] === expected));
};

export function filingLayout({detail, file, result, target, sourceMap}) {
  const kind = /source/.test(file.kind) ? '源程序' : '软件文档';
  const minimum = kind === '源程序' ? 50 : 30;
  const group = sourceMap?.filing_groups[file.volume];
  const rows = detail.layout?.map(({width,height,items},index)=>{
    const number = (file.volume === 'back_30' ? 31 : 1)+index;
    const top = items.filter(item=>item.y >= height-69);
    const headers = top.map(item=>item.text).join(' ');
    const right = normalizeChinese(top.filter(item=>item.right >= width*.79).map(item=>item.text).join(' '));
    const numberMatch = right.match(/(?:第\s*)?(\d+)(?:\s*页|\s*\/\s*\d+)\s*$/u) ??
      right.match(/^\s*(\d+)\s*$/u);
    const body = [];
    for (const row of items.filter(item=>item.y < height-69 && item.y > 45)) {
      if (!body.some(y=>Math.abs(y-row.y)<=2)) body.push(row.y);
    }
    const logical = group?.logical_source_pages[index];
    const effective = logical && sourceMap.pages[logical-1]?.effective_lines;
    return {number,a4:Math.abs(width-595.28)<3 && Math.abs(height-841.89)<3,
      pageNumber:numberMatch ? Number(numberMatch[1]) : null,
      lines:effective === undefined || !logical ? body.length : Math.min(effective,body.length),
      version:sameVersion(headers,target?.version) ?? false,
      name:target?.softwareName ? compact(headers).startsWith(compact(target.softwareName)) &&
        /^[Vv]?\d/u.test(compact(headers).slice(compact(target.softwareName).length)) : null};
  }) ?? [];
  return {path:file.path,kind,minimum,pages:rows,
    scope:group ? '按生成的原稿行号映射核对；完整申报范围待确认。' :
      '不足 60 页须核对是否为该文档全文；达到 60 页须核对首尾各连续 30 页。',
    completeRead:rows.length === result.pageCount && rows.length > 0};
}

// Keep literal whitespace inside rows. Page coordinates also guard leading
// indentation when a PDF stores it as a text offset. A different rendering can
// still be compared when it uses the same text rows and indentation grid.
export function pdfRows(items) {
  const rows = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (!last || Math.abs(item.y-last.y) > 2) {
      rows.push({x:item.x,right:item.right,y:item.y,text:item.text.normalize('NFC')});
    } else {
      last.text += (item.x-last.right > 1 && !/\s$/u.test(last.text) && !/^\s/u.test(item.text) ? ' ' : '')+
        item.text.normalize('NFC');
      last.right = item.right;
    }
  }
  return rows;
}

export function selfReviewPages(detail) {
  if (!detail?.layout?.length) return detail?.pages;
  const scanned = new Set(detail.ocr?.pages.map(page=>page.page));
  return detail.layout.map((page,index)=>scanned.has(index+1) ? detail.pages[index] :
    {lines:pdfRows(page.items).map(row=>normalizeChinese(row.text))});
}

