import { stamp } from './files.mjs';

export function correctionNotices(state) {
  const entries = new Map(state.entries.map(file=>[file.path,file.hash]));
  return (state.preflight?.report.files ?? []).filter(file=>
    /补正/u.test(file.path.split('/').at(-1)) && /\.pdf$/iu.test(file.path) &&
    file.pageCount > 0 && entries.get(file.path) === file.hash)
    .map(({path,hash,pageCount,readPages,ocr})=>({path,hash,pageCount,readPages,
      unread:ocr?.unresolved ?? []}));
}

const materialKeys = ['form','manual','source','rights','response'];

const materialFiles = {
  form:['filing-form','filing-form-word','form-draft'],
  manual:['filing-manual','filing-manual-word','historical-reviewed-manual','uploaded-manual-pdf','manual-pdf'],
  source:['source-pdf','uploaded-source-pdf'],
};

export function correctionStatus(state,allowed=[]) {
  const entries = new Map(state.entries.map(file=>[file.path,file.hash]));
  const output = new Map(allowed.map(file=>[file.path,file.hash]));
  const targets = new Map((state.corrections ?? []).map(item=>[item.id,item]));
  return [...targets.values()].map(item=>{
    const linked = item.links.every(file=>entries.get(file.path) === file.hash);
    const notice = entries.get(item.notice.path) === item.notice.hash;
    const reviewed = item.review && item.review.outputs.every(file=>output.get(file.path) === file.hash) &&
      item.review.input === correctionInput(state);
    return {...item,status:!notice || !linked ? '待换件复核' :
      reviewed ? '内部复核已记录' : item.links.length ? '待逐项复核' : '待补答复或证据'};
  });
}

function correctionInput(state) {
  return stamp({entries:state.entries,target:state.target,policy:state.policy,work:state.preflight?.work.id});
}

export function makeCorrection(state,allowed,input) {
  const field = (value,limit)=>{
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error('请填写有效的通知事项、责任人和复核依据。');
    }
    return value.trim();
  };
  const previous = (state.corrections ?? []).find(item=>item.id === input?.id);
  if (input?.id && !previous) throw new Error('找不到要更新的补正事项。');
  const notice = correctionNotices(state).find(item=>item.path === input?.notice);
  const page = Number(input?.page);
  if (!notice || !Number.isInteger(page) || page<1 || page>notice.readPages || notice.unread.includes(page)) {
    throw new Error('请选择本案已读取且可核对的补正通知页。');
  }
  const issue = field(input.issue,600);
  const owner = field(input.owner,80);
  if (!Array.isArray(input.affects) || !input.affects.length || input.affects.some(key=>!materialKeys.includes(key))) {
    throw new Error('请选择补正影响的材料。');
  }
  const affects = [...new Set(input.affects)];
  const current = new Map(state.entries.map(file=>[file.path,file.hash]));
  const paths = Array.isArray(input.paths) ? [...new Set(input.paths)] : [];
  if (paths.length>12 || paths.some(path=>!current.has(path) || path===notice.path)) {
    throw new Error('请从当前案卷选择答复或依据附件。');
  }
  const links = paths.map(path=>({path,hash:current.get(path)}));
  const binding = {path:notice.path,hash:notice.hash,page};
  const correction = {id:previous?.id ?? stamp({notice:binding,issue}),notice:binding,issue,owner,affects,links};
  if (input.review === true) {
    const outputs = allowed.filter(file=>affects.some(key=>materialFiles[key]?.includes(file.kind)));
    if (!links.length || affects.some(key=>materialFiles[key] && !outputs.some(file=>materialFiles[key].includes(file.kind)))) {
      throw new Error('请补答复及原件，并先复验所有受影响的应交文件。');
    }
    correction.review = {
      reviewer:field(input.reviewer,80),basis:field(input.basis,600),input:correctionInput(state),
      outputs:outputs.map(file=>({path:file.path,hash:file.hash})),at:new Date().toISOString(),
    };
  }
  return [...(state.corrections ?? []).filter(item=>item.id !== correction.id),correction];
}

export function correctionReport(items) {
  const material = {form:'申请表',manual:'说明书',source:'源程序交存件',rights:'权利证明',response:'补正答复'};
  return ['# 本案补正对照','',
    ...items.flatMap(item=>['## '+item.issue,'',
      '- '+item.status+' · '+item.owner,
      '- 通知 '+item.notice.path+' 第 '+item.notice.page+' 页 · '+item.notice.hash,
      '- 受影响材料 '+item.affects.map(key=>material[key]).join('、'),
      ...item.links.map(file=>'- 答复或依据 '+file.path+' · '+file.hash),
      ...(item.status==='内部复核已记录' ? ['- 复核 '+item.review.reviewer+' · '+item.review.at+' · '+item.review.basis,
        ...item.review.outputs.map(file=>'- 复核终件 '+file.path+' · '+file.hash)] : []),'']),
  ].join('\n');
}
