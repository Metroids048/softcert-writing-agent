export const materialTitles = {form:'申请表底稿',manual:'说明书 PDF',source:'源程序交存件'};
const keys = Object.keys(materialTitles);
const terms = {
  form:/申请表|登记表|申报表/u,
  manual:/说明书|操作手册|设计手册|使用手册/u,
  source:/源(?:程序|码|代码)(?:的)?(?:交存|鉴别|册)|(?:交存|鉴别)源(?:程序|码|代码)|程序鉴别材料|交存件/u,
};
const material = new RegExp(Object.values(terms).map(term=>term.source).join('|'),'gu');
const action = /拆成|只要|仅要|仅需|只需|给我|请给|生成|起草|重写|补写|写一份|补齐|补回|输出|交付|(?:需要|想要|要)(?:一套|全套|整套)/u;
const preparation = /准备|整理|帮我出|提供/u;
const review = /(?:仅|只)(?:需|做|帮我)?(?:审核|审查|核|复核)|(?:不用|无需|不必)起草/u;
const reviewProvided = /^\s*(?:请(?:帮我)?|麻烦(?:帮我)?|帮我)(?:审核|审查|复核)(?:我(?:已(?:经)?)?(?:提供|上传|附上|提交)的|已有的?)/u;
const revision = /修订|修正|更正|写回|修一下|改到.{0,10}(?:副本|底稿)/iu;
const full = /(?:一套|全套|整套|三件|三项|完整).{0,10}(?:软著|软件著作权|登记|申报)(?:登记|申报)?(?:材料|文件)|(?:软著|软件著作权|登记|申报)(?:登记|申报)?(?:材料|文件).{0,5}(?:齐全|整套)/u;
const negative = /无须|无需|不用|不必|暂不|先不|不要|不需要|不纳入/u;
const inventory = /原件|已附|已经|我已|我把|随附|已上传|上传了/u;
const retention = /(?:保留|沿用)(?:现有|已有|原有|上次的?)/u;

export function materialIntent(request, selected, legacyDraft) {
  const requested = new Set(), excluded = new Set();
  const clauses = request.normalize('NFKC').split(/[。.!！？?；;\n，,]+/u);
  const readOnly = reviewOnlyRequest(request);
  let ongoing = false, generate = false, manualPdfOnly = false, revise = false, clarify = false;
  for (const clause of clauses) {
    const items = [...clause.matchAll(material)];
    const negated = clause.search(negative);
    const tailNegation = negated >= 0 && items.length && negated > items.at(-1).index;
    const edit = revision.test(clause);
    const positive = action.test(clause) || preparation.test(clause) || edit;
    const retain = items.length > 0 && retention.test(clause);
    if (full.test(clause) && !inventory.test(clause) && negated < 0) {
      keys.forEach(key=>requested.add(key));
      generate = ongoing = true;
      continue;
    }
    if (inventory.test(clause) && !positive) { ongoing = false; continue; }
    if (tailNegation || negated >= 0 && negated < (items[0]?.index ?? Infinity)) {
      for (const item of items) excluded.add(keys.find(key=>terms[key].test(item[0])));
      ongoing = false;
      continue;
    }
    if (!positive && !retain && !ongoing && !(readOnly && /复核|审核|审查|核对/u.test(clause))) continue;
    if (positive && negated < 0 && !readOnly) generate = true;
    revise ||= edit;
    ongoing = positive || retain || ongoing;
    const boundary = clause.match(/(?:只|仅)(?:需|要|生成|提供|出|做|交付|用)/u);
    for (const item of items) {
      const key = keys.find(candidate=>terms[candidate].test(item[0]));
      if (negated >= 0 && item.index > negated) excluded.add(key);
      else requested.add(key);
      if (key === 'manual' && boundary && /PDF/iu.test(clause)) manualPdfOnly = true;
    }
    if (boundary && items.length === 0 && positive) clarify = true;
  }
  const expected = selected ? keys.filter(key=>selected.includes(key)) :
    keys.filter(key=>(requested.size ? requested.has(key) : legacyDraft && key !== 'source') && !excluded.has(key));
  const draftRequested = !readOnly && !revise && expected.length > 0 && (generate || legacyDraft || !!selected);
  return {expected,excluded:keys.filter(key=>excluded.has(key) && !expected.includes(key)),readOnly,
    explicit:!!selected || requested.size > 0 || excluded.size > 0,draftRequested,revise,
    manualPdfOnly:!readOnly && manualPdfOnly && expected.length===1 && expected[0]==='manual',
    needsConfirmation:!selected && !expected.length && (clarify || excluded.size > 0 || generate && !revise)};
}

export function materialScope(request, selected, legacyDraft) {
  return materialIntent(request,selected,legacyDraft).expected;
}

export function draftingRequest(request) {
  return materialIntent(request,null,false).draftRequested;
}

export function reviewOnlyRequest(request) {
  if (review.test(request)) return true;
  const initialReview = request.match(reviewProvided);
  if (!initialReview) return false;
  const rest = request.slice(initialReview[0].length);
  return !action.test(rest) && !preparation.test(rest) && !revision.test(rest);
}

export function requestName(request) {
  return request.match(/(?:^|[。\n])\s*(?:请(?:帮我)?|我想|想请你|麻烦)?\s*(?:给|为)\s*([^。\n，；]{1,80}?)\s+[Vv]\d+(?:\.\d+){1,3}\s*(?:整理|准备|起草|写|做|生成|核对)/u)?.[1].trim();
}

export function sourceVolumes(sourceMap, requested) {
  const planned = Object.keys(sourceMap?.filing_groups ?? {});
  return planned.length ? planned : requested ? ['all'] : [];
}

export function requiredDelivery(expected, allowed, verifiedSources, volumes, mode, byPath, {manualPdfOnly=false,requireWord=false}={}) {
  const knownSource = allowed.filter(file=>file.kind === 'source-pdf' ||
    (file.kind === 'uploaded-source-pdf' && verifiedSources.some(ref=>ref.path === file.path && ref.sha256 === file.hash)));
  const manuals = allowed.filter(file=>file.kind === 'filing-manual' ||
    (mode !== 'draft' && file.kind === 'manual-pdf') ||
    (mode === 'review' && file.kind === 'uploaded-manual-pdf'));
  const exportedFrom = new Set(manuals.filter(file=>file.kind === 'manual-pdf').map(file=>file.from));
  const editable = allowed.filter(file=>['filing-manual-text','filing-manual-word'].includes(file.kind) ||
    (mode === 'revise' && exportedFrom.has(file.path)));
  return expected.map(key=>{
    let files;
    const missing = [];
    if (key === 'source') {
      files = knownSource.filter(file=>volumes.includes(file.volume ??
        verifiedSources.find(ref=>ref.path === file.path)?.volume));
      for (const volume of volumes) {
        if (files.some(file=>(file.volume ?? verifiedSources.find(ref=>ref.path === file.path)?.volume) === volume)) continue;
        missing.push({all:'源程序交存 PDF',front_30:'源程序交存 PDF（前30页）',back_30:'源程序交存 PDF（后30页）'}[volume]);
      }
    } else if (key === 'form') {
      files = allowed.filter(file=>['filing-form','filing-form-word'].includes(file.kind) ||
        (mode !== 'draft' && byPath.get(file.path)?.role === 'form'));
      if (!files.length) missing.push(materialTitles.form);
      if (mode === 'draft' && requireWord && !files.some(file=>file.kind === 'filing-form-word')) missing.push('申请表底稿 Word');
    } else {
      files = [...manuals,...editable];
      if (!manuals.length) missing.push(materialTitles.manual);
      if (mode === 'draft' && !manualPdfOnly && !editable.some(file=>
        requireWord ? file.kind === 'filing-manual-word' : file.kind === 'filing-manual-text')) missing.push('可编辑说明书');
    }
    return {key,title:materialTitles[key],status:missing.length ? '待补' : '经审核',missing,
      files:files.map(({path,hash})=>({path:'经审核材料/'+path,sha256:hash}))};
  });
}
