import { inspectFiles, JSZip } from './runtime.mjs';
import { digest, stamp } from './files.mjs';
import { scanTranscript } from './scan-ocr.mjs';
import { checkSourceBooklets } from './source-check.mjs';
import { operationDraftMatches, operationFacts, reviewRuntimeEvidence, runtimeLaunch } from './runtime-evidence.mjs';
import { launchMatches } from './filing/packaged-web.mjs';
import { sourceLayoutSummary } from './filing/evidence.mjs';
import { manuscriptVersions, versionSummary } from './version-check.mjs';

import { featureDraftCheck } from './filing/feature-evidence.mjs';
import { filingLayout, selfReviewPages, normalizeChinese } from './filing/layout.mjs';
import { selfReviewInput, uploadedSourceMatch, reviewSelfManuals } from './filing/self-review.mjs';
import { separateManualClaims } from './filing/manual-claims.mjs';
import { crossCheckOCR, verifyOcrAssignments, verifyOcrOutputs } from './filing/ocr-evidence.mjs';
import { manualTableRows, tableExamples, verifyManualTables } from './filing/manual-tables.mjs';
import { manualContinuations, missingManualContinuations } from './filing/manual-continuations.mjs';
import { unverifiedMeasurements } from './filing/measurements.mjs';
import { tableCaptions, unverifiedTableReferences, withoutTableReferences } from './filing/table-references.mjs';
import { applicationActions, applicationDraftLines, applicationReport, applicationRow } from './application-check.mjs';
import { submissionReadiness } from './submission-readiness.mjs';
import { requiredDelivery, sourceVolumes } from './deliverables.mjs';
import { correctionStatus } from './corrections.mjs';

export const ruleVersion = 'R1-R7/0.3.22';
const compact = value => value.normalize('NFKC').replace(/\s+/gu,'');
const isDeliveryDoc = file => ['form','manual','source'].includes(file.role);
const phaseRow = value => value === 1 ? '已核对' : '待补';

function directoryIssues(detail) {
  const pages = detail.pages ?? [];
  const issues = [];
  for (const [index,page] of pages.entries()) {
    if (!page.lines.some(line => /^(?:目\s*录|Contents)$/i.test(line.trim()))) continue;
    for (const line of page.lines) {
      const entry = line.trim().match(/^(\d{1,2}\s+[^.。…·]+?)\s*[.。…·]{3,}\s*(\d+)$/u);
      if (!entry) continue;
      const heading = compact(entry[1]);
      const actual = pages.findIndex((later,pageIndex) => pageIndex > index &&
        later.lines.some(text => compact(text.trim()) === heading));
      if (actual === -1) continue;
      const printed = pages[actual].lines.slice(0,3).map(text => text.match(/第\s*(\d+)\s*页/u)).find(Boolean);
      const observed = printed ? Number(printed[1]) : actual+1;
      if (observed !== Number(entry[2])) issues.push({id:'R6',path:detail.path,
        location:page.label, detail:'目录「'+entry[1]+'」写为 '+entry[2]+' 页，实际标题出现在 '+observed+' 页。'});
    }
  }
  return issues;
}

function roleEvidenceIssues(detail, hasSeparateRoutes) {
  if (!hasSeparateRoutes) return [];
  const issues = [];
  for (const page of detail.pages ?? []) {
    for (const [lineIndex,text] of page.lines.entries()) {
      const line = compact(text);
      if (!/(?:从|在).{0,8}\/messages/.test(line) ||
          !/(?:连续完成|Sendprivatemessage.{0,50}Submit)/i.test(line)) continue;
      issues.push({id:'R5',path:detail.path,location:page.label ?? '段落 '+(lineIndex+1),
        detail:'/messages 是收件箱。冻结源码另有 /send_message/<recipient> 发信入口，核实发送方、接收方和实际结果。'});
      break;
    }
  }
  return issues;
}

function printedSourcePages(detail, pageCount) {
  if (pageCount <= 60 || detail?.pages?.length !== pageCount) return '';
  const labels = detail.pages.map(page=>page.lines.map(line=>
    /^第(\d+)页[/／]共(\d+)页$/u.exec(compact(line))).filter(Boolean));
  const first = labels.findIndex(page=>page.length);
  if (first < 0 || first > 1 || labels.slice(first).some(page=>page.length !== 1)) return '';
  const [[, , fullCount]] = labels[first];
  const numbers = labels.slice(first).map(([match])=>Number(match[1]));
  if (labels.slice(first).some(([match])=>match[2] !== fullCount) ||
      numbers.some((number,index)=>number < 1 || number > Number(fullCount) || number <= (numbers[index-1] ?? 0))) return '';
  const ranges = [];
  for (const number of numbers) {
    const last = ranges.at(-1);
    if (last?.end === number-1) last.end = number;
    else ranges.push({start:number,end:number});
  }
  const actual = ranges.map(({start,end})=>start === end ? String(start) : start+'–'+end).join('、');
  return '原册页脚显示原程序共 '+fullCount+' 页，附册代码页为 '+actual+'。'+
    (first ? '上传件第 1 页未见该组页码。' : '')+
    (Number(fullCount) > 60 ? '按同一原稿的一般交存范围核对 1–30、'+(Number(fullCount)-29)+'–'+fullCount+'。' : '');
}

export async function auditCandidate({state, origin, read, revision}) {
  const candidate = state.candidate;
  const work = state.preflight.work;
  if (!work || candidate.workId !== work.id) throw new Error('候选与本次预检的交付范围不一致。');
  const {facts} = candidate;
  const runtimeBeforeDraft = reviewRuntimeEvidence(state,read);
  const expectedOperations = work.draftRequested && !selfReviewInput(state,read) && !candidate.conflict ?
    operationFacts(runtimeBeforeDraft) : [];
  const {launch:expectedLaunch,replay} = runtimeLaunch(state,work.expected.includes('manual') ? expectedOperations : [],read);
  const web = state.preflight.packaged?.web;
  if (stamp(facts.features) !== stamp(work.features) || stamp(facts.runtime) !== stamp(runtimeBeforeDraft) ||
      stamp(facts.operations) !== stamp(expectedOperations) || stamp(facts.launch) !== stamp(expectedLaunch)) {
    throw new Error('起草事实与当前案卷的原件或实操凭证不一致。');
  }
  for (const item of replay) read(item);
  const auditInput = [...candidate.files, ...candidate.references];
  const {report, details} = await inspectFiles(origin,auditInput.map(file=>({...file,bytes:read(file)})), 'review', true);
  const byPath = new Map(report.files.map(file=>[file.path,file]));
  const detailMap = new Map(details.map(detail=>[detail.path,detail]));
  const issues = [];
  const observations = [];
  const layout = [];
  const draftReasons = new Map();
  const add = (id,path,location,detail) => issues.push({id,path,location,detail});
  const sourcePending = state.preflight.packaged?.sourcePending;
  const {applicationCheck} = candidate;
  const originalEntries = new Map(state.entries.map(file=>[file.path,file]));
  const applicationSources = [...applicationCheck.references,...applicationCheck.items.flatMap(item=>[...item.evidence,...item.attachments])];
  if (stamp(applicationCheck) !== stamp(state.preflight.applicationCheck)) throw new Error('R3 核对与本次预检不一致。');
  for (const [path,sha256] of new Map(applicationSources.map(hit=>[hit.path,hit.sha256]))) {
    const file = originalEntries.get(path);
    if (!file || file.hash !== sha256) throw new Error('R3 核对找不到对应的上传原件。');
    read(file);
  }
  const originalsByPath = new Map(candidate.files.map(file=>[file.originalPath ?? file.path,file]));
  const scanPages = ['form','manual'].flatMap(role=>details.flatMap(detail=>{
    const file = originalEntries.get(detail.path);
    const parsed = byPath.get(detail.path);
    if (parsed?.role !== role || file?.hash !== parsed.hash) return [];
    return (detail.ocr?.pages ?? []).map(page=>({path:detail.path,number:page.page,ocr:true,lines:page.lines,
      bodyLines:role === 'manual' ? page.bodyLines : undefined,tables:page.tables,
      outputExamples:page.outputExamples}));
  }));
  const literalFacts = crossCheckOCR(scanPages,state.entries,candidate.sourceMap?.files.map(file=>file.path) ?? [],read);
  const literalReport = candidate.files.find(file=>file.kind === 'filing-ocr');
  const literalReportText = literalReport ? read(literalReport).toString('utf8') : '';
  const measurements = candidate.files.find(file=>file.kind === 'filing-measurements');
  const measurementText = measurements ? read(measurements).toString('utf8') : '';
  const tables = candidate.files.find(file=>file.kind === 'filing-tables');
  const tableText = tables ? read(tables).toString('utf8') : '';
  const captions = tableCaptions(details.filter(detail=>byPath.get(detail.path)?.hash ===
    originalEntries.get(detail.path)?.hash),state.entries);
  const expectedTables = manualTableRows(scanPages.filter(page=>page.bodyLines),captions,new Set());
  const expectedContinuations = manualContinuations(scanPages,state.entries);
  const tableLiterals = tableExamples(expectedTables,literalFacts.assignments);
  const booklets = candidate.files.filter(file=>['uploaded-source-pdf','historical-source-original'].includes(file.kind));
  issues.push(...checkSourceBooklets({report,details},candidate.target,booklets).map(hit=>({id:'R4',...hit})));
  const reviewInput = selfReviewInput(state,read);
  const uploadedSources = [];
  const generatedSources = candidate.files.filter(file=>file.kind === 'source-pdf');
  if (reviewInput && candidate.sourceMap?.source_snapshot?.scopeSha256 !== reviewInput.sha256) {
    add('R4',reviewInput.path,'交存范围',reviewInput.error ??
      '清单中的源码、发布版本或文件指纹未能与本次确认的交存范围对应。');
  }
  const transcripts = [];
  const hasSeparateRoutes = candidate.references.some(file => /\.py$/i.test(file.path) &&
    /\/send_message\s*\//u.test((detailMap.get(file.path)?.pages ?? []).flatMap(page=>page.lines).join('\n')) &&
    /["']\/messages["']/u.test((detailMap.get(file.path)?.pages ?? []).flatMap(page=>page.lines).join('\n')));
  for (const file of candidate.files) {
    const result = byPath.get(file.path);
    if (!result || result.hash !== file.hash) throw new Error('审核读到的文件指纹不一致。');
    if (sourcePending && ['source-pdf','source-docx','uploaded-source-pdf'].includes(file.kind)) {
      add('R4',file.path,'交存范围',sourcePending.detail);
    }
    if (sourcePending && ['filing-manual','filing-manual-word','uploaded-manual-pdf'].includes(file.kind)) {
      draftReasons.set(file.path,'实际启动入口待复核。'+sourcePending.detail);
    }
    const detail = detailMap.get(file.path);
    const lines = (detail?.pages ?? []).flatMap(page=>page.lines);
    if (['filing-form','filing-manual','filing-manual-text'].includes(file.kind)) {
      // The issued PDF repeats its name, version and page number above the body.
      // Exclude that header when a source sentence wraps onto the following page.
      const actualPages = file.kind === 'filing-manual' ?
        (detail?.layout ?? []).map(({items,height})=>{
          const rows = [];
          let prior;
          for (const item of items.filter(item=>item.y < height-55 && item.y > 45)) {
            if (!prior || Math.abs(item.y-prior.y) > 0.1) rows.push(item.text);
            else rows[rows.length-1] += (item.x-prior.right > 0.9 ? ' ' : '')+item.text;
            prior = item;
          }
          return rows.join('\n');
        }) : [read(file).toString('utf8')];
      const actual = actualPages.join('\n');
      const manual = file.kind !== 'filing-form';
      if (file.kind !== 'filing-manual' && candidate.target?.softwareName) {
        const stated = actual.match(/^软件全称：(.+)$/mu)?.[1]?.trim();
        if (!stated || normalizeChinese(stated) !== normalizeChinese(candidate.target.softwareName)) {
          add('R2',file.path,'软件全称','底稿中的软件全称与本案确认的名称不一致。');
        }
      }
      if (!manual && candidate.sourceMap &&
          !actual.split('\n').some(line=>line.startsWith('- 源程序量：') && line.includes(sourceLayoutSummary(candidate.sourceMap)))) {
        add('R7',file.path,'源程序量','底稿中的排版数量或补充来源与本案交存清单不一致。');
      }
      if (!operationDraftMatches(facts.operations,actual,file.kind)) {
        add(manual ? 'R5' : 'R7',file.path,'同版实操与结果',
          '实际终件未完整保留锁定的动作、结果或记录出处。');
      }
      if (file.kind !== 'filing-form' && !launchMatches(expectedLaunch,actual)) {
        add('R6',file.path,'启动与准备','实际说明书与本案同版启动步骤不一致。');
      }
      if (manual && !reviewInput) {
        const features = featureDraftCheck(facts.features,actual,candidate.sourceMap ?? candidate.sourceBasis,file.kind === 'filing-manual');
        if (features.missing || features.sourceMismatch) add('R5',file.path,'功能、操作与出处',
          '终件中的功能、操作、结果或源码出处与预检锁定的原件记录不符。');
      }
      const missing = manual ? actualPages.reduce((remaining,page)=>missingManualContinuations(remaining,page),
        expectedContinuations) : [];
      for (const row of missing) {
        add('R5',file.path,'跨页段落','实际终件未在同一页保留完整段落及双页出处。核 '+row.path+' 物理'+row.loc+'。');
      }
      const tableCheck = verifyManualTables(manual ? expectedTables : [],actual);
      if (!tableCheck.valid) {
        add('R5',file.path,'原件表格','终件中的表格行、单元格或来源与本案原件不一致。');
      }
      for (const fact of verifyOcrAssignments(literalFacts.assignments,tableCheck.text,literalReportText,manual,
          manual ? tableLiterals : [])) {
        add('R5',file.path,'字面 '+fact.id,'实际终件的参数字面或依据不符。核 '+fact.original+' 物理第 '+fact.page+' 页。');
      }
      for (const fact of verifyOcrOutputs(literalFacts.outputs,actual,literalReportText)) {
        add('R5',file.path,'自检输出','实际终件的示例字面、待验证标注或来源不符。核 '+fact.path+' 物理第 '+fact.page+' 页。');
      }
      for (const claim of unverifiedMeasurements(withoutTableReferences(actual),measurementText,state.entries)) {
        add('R7',file.path,'实测数字归属','实际终件缺少可核历史出处或同版运行依据。'+claim.slice(0,90));
      }
      for (const label of new Set(unverifiedTableReferences(actual,tableText,captions))) {
        add('R6',file.path,'原件图表引用',label+' 在实际终件中缺少可唯一核对的同包原件、物理页或索引。');
      }
    }
    if (['filing-form-word','filing-manual-word'].includes(file.kind)) {
      const from = candidate.files.find(item=>item.path===file.from);
      const expected = from && read(from).toString('utf8').split(/\r?\n/u).filter(line=>line.trim())
        .map(line=>line.replace(/^#{1,3} |^- /u,'').replaceAll('`','')).map(compact);
      const actual = lines.filter(line=>line.trim()).map(compact);
      const archive = await JSZip.loadAsync(read(file));
      const media = await Promise.all(Object.values(archive.files).filter(item=>!item.dir && item.name.startsWith('word/media/'))
        .map(async item=>digest(await item.async('nodebuffer'))));
      if (!expected || stamp(actual) !== stamp(expected) ||
          stamp([...new Set(media)].sort()) !== stamp([...new Set(file.figures)].sort())) {
        add('R6',file.path,'Word 终件回读','可编辑终件的段落或实操原图未完整对上本次底稿。');
      } else observations.push({id:'R6',path:file.path,detail:'已读回可编辑终件段落及嵌入图片，并核对同一份起草内容。'});
    }
    if (file.kind === 'filing-manual') {
      if (!result.pageCount || result.ocr?.unresolved.length || result.unreadable || result.truncated || result.blank ||
          !lines.some(line=>line.includes('说明书'))) {
        add('R6',file.path,'说明书正文','说明书正文未能完整读回。');
      } else observations.push({id:'R6',path:file.path,
        detail:'已核读生成说明书 '+result.pageCount+' 页。可在输入清单中对照未改动的原说明书。'});
    } else if (result.ocr) {
      const {pages,unresolved,unavailable} = result.ocr;
      if (pages.length) observations.push({id:'R6',path:file.path,
        detail:'已识别扫描第 '+pages.join('、')+' 页。识别文本供检索和人工校读，版式及内容以原 PDF 为准。'});
      if (pages.length && !candidate.transcripts.some(item=>item.original === (file.originalPath ?? file.path))) {
        add('R6',file.path,'扫描识别文本','候选缺少本次识别的逐页文本，请重新运行当前材料。');
      }
      if (unresolved.length) add('R6',file.path,'实际终件',
        '扫描第 '+unresolved.join('、')+' 页需人工核读。'+(unavailable?'本机 OCR 本次未完成。':''));
    } else if (isDeliveryDoc(result) && (result.unreadable || result.blank || result.truncated || !lines.some(line=>line.trim()))) {
      add('R6',file.path,'实际终件',result.unreadable || '存在空白、未读页或无法验证的内容。');
    }
    if (result.ocr && result.truncated) add('R6',file.path,'实际终件','超出当前 PDF 读取范围，仍有页面待核。');
    if (file.kind?.startsWith('filing-')) {
      if (!file.evidence?.length || !file.evidence.every(ref=>state.entries.some(input=>input.path === ref.path &&
          input.hash === ref.hash))) add('R6',file.path,'原稿绑定','未能核实本次引用的原件。');
    }
    if (file.kind === 'filing-form' || file.kind === 'filing-checklist') {
      const expected = file.kind === 'filing-form' ? applicationDraftLines(applicationCheck).join('\n') :
        applicationReport(applicationCheck).replace(/^# R3 /u,'## R3 ');
      if (!read(file).toString('utf8').includes(expected)) {
        add('R3',file.path,'主体、权属和签章字段','此草稿未保留本次预检的原件记载和待补责任，请重新生成。');
      }
    }
    const uploadedSource = file.kind === 'uploaded-source-pdf';
    const selfManual = file.kind === 'uploaded-manual-pdf' && !file.supersededByFiling;
    const sourceMatch = uploadedSource && uploadedSourceMatch(file,detail,generatedSources,detailMap);
    if (detail?.layout && (['source','manual'].includes(result.role))) {
      const form = candidate.files.find(item=>item.kind === 'filing-form');
      const text = form && read(form).toString('utf8');
      const formName = text?.match(/^软件全称：(.+)$/mu)?.[1];
      const formVersion = text?.match(/^版本号：(.+)$/mu)?.[1];
      const source = file.kind === 'source-pdf' || uploadedSource;
      const target = {softwareName:candidate.target?.softwareName ?? formName ?? candidate.sourceMap?.software_name,
        version:formVersion ?? candidate.target?.version ?? (source ? candidate.sourceMap?.version : undefined)};
      const check = filingLayout({detail,file:sourceMatch ? {...file,volume:sourceMatch.volume} : file,
        result,target,sourceMap:candidate.sourceMap});
      if (file.kind === 'filing-manual') {
        check.bodyRows = file.layout.bodyRows;
        check.scope = file.layout.fullPages > 60 ? '交存前后各连续 30 页，完整正文见可编辑稿。' :
          '生成的全部说明书页面。需核对完整功能范围及匹配的同版截图。';
      }
      layout.push(check);
      if (source || selfManual || file.kind === 'filing-manual') {
        const short = check.pages.filter(page=>page.lines<check.minimum).map(page=>page.number);
        const malformed = !check.completeRead || check.pages.some(page=>!page.a4 || page.pageNumber!==page.number ||
          !page.version || page.name!==true);
        const gaps = file.gaps ?? [];
        const reasons = [
          ...(short.length ? ['第 '+short.join('、')+' 页不足 '+check.minimum+' 行。'] : []),
          ...(malformed ? ['A4、实际页码、软件全称或版本未通过。'] : []),
          ...(file.layout?.qualified === false ? ['现有证据无法组成每页至少 30 行的说明书正文。'] : []),
          ...(gaps.length ? ['缺少可核的'+gaps.join('、')+'。'] : []),
        ];
        if (reasons.length) draftReasons.set(file.path,reasons.join(''));
        else if (sourceMatch) uploadedSources.push(sourceMatch);
      }
    }
    if (['form-draft','filing-form'].includes(file.kind)) observations.push({id:'R3',path:file.path,
      detail:'已核读申请表字段底稿。需按现行在线申请表重新填报并签章。'});
    if (/\.pdf$/i.test(file.path) && (!result.a4 ||
        lines.some(line=>/[\uFFFD\u25A0\u25A1]{2,}|\(cid:\d+\)/u.test(line)) ||
        (result.role === 'manual' && lines.filter(line=>/(\p{Script=Han})\1{7,}/u.test(compact(line))).length >= 3))) {
      add('R6',file.path,'PDF 正文','A4 规格或中文文本读回异常，请检查实际导出页。');
    }
    if (result.role === 'manual') {
      issues.push(...roleEvidenceIssues(detail,hasSeparateRoutes));
      if (/\.pdf$/i.test(file.path)) issues.push(...directoryIssues(detail));
    }
    if (result.role === 'manual' || ['filing-manual','filing-manual-text'].includes(file.kind)) {
      for (const [index,page] of (detail?.pages ?? []).entries()) {
        const {claims} = separateManualClaims(page.lines.join('\n'));
        if (!claims.length) continue;
        const location = result.pageCount ? '第 '+(index+1)+' 页' : '正文';
        if (file.supersededByFiling) {
          observations.push({id:'R7',path:file.path,
            detail:location+' 含原件实操来源声明，保留原件供对照。'});
        } else {
          add('R7',file.path,location,'检测到未经本次证据核验的实操来源声明。请核对对应的同版截图和输出。');
        }
      }
    }
    if (file.kind === 'historical-reviewed-manual') {
      const destinations = detail.destinations ?? [];
      const hasNote = compact(detail.pages?.[18]?.lines.join('') ?? '').includes('中途缺号会提前结束');
      if (destinations.length !== 26 || destinations.some(page=>!(page >= 2 && page <= result.pageCount)) || !hasNote) {
        add('R6',file.path,'首页目录及第 19 页','未能复核 26 个有效目录跳转和缺帧说明。');
      } else observations.push({id:'R6',path:file.path,detail:'已从实际 PDF 验证 26 个目录跳转及第 19 页的缺帧说明。'});
    }
    if (file.kind === 'historical-source-original' && result.pageCount === 29 && !result.blank) {
      observations.push({id:'R4',path:file.path,detail:'已读到 29 页历史交存正文。当前版本和适用交存要求仍需核验。'});
    }
    if (uploadedSource && !sourceMatch && !issues.some(issue=>issue.id === 'R4' && issue.path === file.path)) {
      const size = result.pageCount > 60 ? '实际上传 '+result.pageCount+
        ' 页。一般交存请从确定的原稿提取前、后各连续 30 页，核对分卷边界。' : '';
      add('R4',file.path,'交存选页与源码溯源',size+printedSourcePages(detail,result.pageCount)+
        '自备源码册未能逐页对到冻结源码的行号映射及参照正文。请核对同版来源、顺序、换行和缺页。');
    }
    if (selfManual && !detail?.layout?.length) {
      add('R6',file.path,'实际终件','自备说明书未能读回版式。');
    }
    if (file.kind === 'source-pdf') {
      const expected = candidate.sourceMap.filing_groups[file.volume];
      const valid = detail.pages?.every((page,index) => {
        const logical = expected.logical_source_pages[index];
        const pageMeta = candidate.sourceMap.pages[logical-1];
        const filingPage = file.volume === 'back_30' ? 31+index : index+1;
        return page.lines.filter(line=>line.trim()).length >= pageMeta.line_count &&
          page.lines.slice(0,3).some(line=>new RegExp('第\\s*'+filingPage+'\\s*页').test(line));
      });
      if (result.pageCount !== file.expectedPages || !valid) {
        add('R4',file.path,'交存页','实际 PDF 的页数、页号或有效行数与交存行号映射不相符。');
      } else if (candidate.sourceMap.source_snapshot) {
        observations.push({id:'R4',path:file.path,
          detail:'本卷 '+file.expectedPages+' 页已核对印刷页码及有效源码行数，固定上传源码可逐页追溯。'});
      }
    }
    const changes = candidate.changes.filter(change=>change.path === (file.from || file.path));
    for (const change of changes) {
      const correct = file.from ? compact(lines.join('')).includes(compact(change.after)) : lines[change.index] === change.after;
      if (!correct) add('R6',file.path,change.loc,'复读终件未找到应该写回的内容。');
    }
  }
  for (const transcript of candidate.transcripts) {
    const file = originalsByPath.get(transcript.original);
    const ocr = detailMap.get(file?.path ?? transcript.original)?.ocr;
    if (!ocr || ocr.hash !== transcript.sourceHash ||
        digest(scanTranscript(transcript.original,ocr)) !== transcript.hash) {
      add('R6',file?.path ?? transcript.original,'扫描识别文本','识别副本与本次核读不一致，请重新运行当前材料。');
      continue;
    }
    read(transcript);
    transcripts.push(transcript);
  }
  const {versionCheck} = candidate;
  if (candidate.conflict) {
    for (const file of candidate.files.filter(file => versionCheck.blocking || ['manual','form'].includes(byPath.get(file.path)?.role))) {
      add('R2',file.path,versionCheck.blocking ? '起草前版本核对' : '名称或版本证据',
        versionCheck.blocking ? '本案起草已暂缓，原件供核对。版本出处和待确认事项见《版本核对.md》。' :
          '本案仍有申请名称或软件版本冲突。');
    }
  } else if (versionCheck.reference) {
    const reviewedDocuments = candidate.files.filter(file=>!file.supersededByFiling &&
      !file.kind?.startsWith('historical-')).map(file=>byPath.get(file.path));
    for (const hit of manuscriptVersions(reviewedDocuments,details)) {
      if (hit.version && hit.version !== versionCheck.reference) add('R2',hit.path,hit.location,
        '终件版本 '+hit.version+'，起草前核对版本 '+versionCheck.reference+'。');
    }
  }
  if (candidate.sourceMap) {
    const currentInputs = new Map(state.entries.map(file=>[file.path,file.hash]));
    const files = candidate.sourceMap.files;
    const {entrypoints,paths,pythonDistribution} = state.preflight.packaged ?? {};
    if (candidate.sourceMap.runtime_resource_scope) {
      for (const item of web?.supplements ?? []) {
        read(item);
        currentInputs.set(item.path,item.hash);
      }
    }
    const expectedScope = web && {archiveSha256:web.archiveSha256,proof:web.proof,files:web.decisions,supplements:web.supplements,
      ...(web.commit && {commit:web.commit,lineExclusions:web.lineExclusions})};
    const mappedScope = candidate.sourceMap.runtime_resource_scope;
    const excluded = (web?.lineExclusions ?? []).some(range=>candidate.sourceMap.line_mapping.some(line=>
      line.file === range.path && line.source_line >= range.first && line.source_line <= range.last));
    const currentPackaged = !candidate.conflict && !work.readOnly && !reviewInput &&
      (web || entrypoints?.length || pythonDistribution);
    if (excluded || !files.every(file=>currentInputs.get(file.path) === file.sha256) ||
        mappedScope && stamp(mappedScope) !== stamp(expectedScope) ||
        currentPackaged && (stamp(mappedScope ?? null) !== stamp(expectedScope ?? null) ||
          stamp(candidate.sourceMap.python_distribution_scope ?? null) !== stamp(pythonDistribution ?? null) ||
          stamp(candidate.sourceMap.runtime_entrypoints ?? []) !== stamp(entrypoints) ||
          stamp(files.map(file=>file.path)) !== stamp(paths))) {
      for (const file of candidate.files.filter(file=>file.kind?.startsWith('source-') || file.kind === 'uploaded-source-pdf')) {
        add('R4',file.path,'行号映射','映射和冻结源码指纹不符。');
      }
    }
  }
  const hasFinding = path=>issues.some(item=>item.path === path);
  const intactSources = uploadedSources.filter(item=>!hasFinding(item.reference) && !draftReasons.has(item.reference));
  for (const item of uploadedSources) {
    if (!intactSources.includes(item)) add('R4',item.path,'源码溯源','参照册本次未通过复核。');
    else observations.push({id:'R4',path:item.path,
      detail:'自备册 '+item.pages+' 页的正文已按'+item.matchMode+'与固定源码对应，行号映射见包内索引。'});
  }
  const eligibleManuals = candidate.files.filter(file=>byPath.get(file.path)?.role === 'manual' &&
    !hasFinding(file.path) && !draftReasons.has(file.path) && !file.supersededByFiling);
  const selfManuals = candidate.files.filter(file=>file.kind === 'uploaded-manual-pdf' && !file.supersededByFiling);
  const reviewDetails = new Map(detailMap);
  for (const file of candidate.files.filter(file=>['manual','form'].includes(byPath.get(file.path)?.role))) {
    const detail = detailMap.get(file.path);
    if (detail?.layout?.length) reviewDetails.set(file.path,{...detail,pages:selfReviewPages(detail)});
  }
  const provisionalRuntime = reviewRuntimeEvidence(state,read,eligibleManuals,reviewDetails);
  const selfReview = reviewSelfManuals({state,input:reviewInput,details:reviewDetails,byPath,read,
    runtime:provisionalRuntime,manuals:selfManuals,original:work.features});
  for (const manual of selfReview.reviews) {
    if (manual.status === '内容待核') add('R5',manual.path,'说明书功能逐项核对',manual.detail);
    if (manual.status === '范围待核') draftReasons.set(manual.path,
      [draftReasons.get(manual.path),manual.detail].filter(Boolean).join(' '));
  }
  const coverageMissing = reviewInput || !work.features ? [] : work.features.names.filter(row=>
    !work.features.manuals.some(manual=>manual.features.some(feature=>feature.name === row.name && feature.complete)));
  for (const path of selfReview.unmatched) add('R7',reviewInput.path,'说明书指纹绑定',
    '功能核对清单中没有找到自备说明书 '+path+'。');
  for (const file of candidate.files.filter(file=>['filing-form','filing-manual'].includes(file.kind))) {
    const incomplete = work.readingGaps.filter(gap=>file.evidence?.some(ref=>ref.path===gap.path && ref.hash===gap.hash));
    if (incomplete.length) draftReasons.set(file.path,[draftReasons.get(file.path),
      ...incomplete.map(gap=>gap.path+'。'+gap.detail)].filter(Boolean).join(' '));
    if (file.kind === 'filing-manual' && coverageMissing.length) draftReasons.set(file.path,
      [draftReasons.get(file.path),'申请表功能待核：'+coverageMissing.map(row=>row.name).join('、')+'。'].filter(Boolean).join(' '));
  }
  const blocked = new Set(issues.map(issue=>issue.path));
  for (const file of candidate.files.filter(file=>file.from)) {
    if (blocked.has(file.from) && !blocked.has(file.path)) {
      blocked.add(file.path);
      add('R6',file.path,'关联 Word','对应 Word 有待修问题。');
    }
  }
  for (const file of candidate.files.filter(file=>file.kind === 'source-docx')) {
    const pdf = candidate.files.find(item=>item.kind === 'source-pdf' && item.volume === file.volume);
    if (!pdf || blocked.has(pdf.path) || draftReasons.has(pdf.path)) draftReasons.set(file.path,
      '同卷 PDF 未通过交存版式回读。此可编辑副本供补证和整理。');
  }
  const inScope = file=>!file.comparisonOnly && (!work.manualPdfOnly ||
    file.kind !== 'filing-manual-text' && !byPath.get(file.path)?.role?.match(/^(?:form|source)$/u));
  const drafts = candidate.files.filter(file=>inScope(file) && !blocked.has(file.path) && draftReasons.has(file.path))
    .map(file=>({file,reason:draftReasons.get(file.path)}));
  const draftPaths = new Set(drafts.map(({file})=>file.path));
  const completed = new Set(candidate.files.filter(file=>['filing-form','filing-manual'].includes(file.kind) &&
    !blocked.has(file.path) && !draftPaths.has(file.path)).flatMap(file=>file.evidence?.map(ref=>ref.path) ?? []));
  const superseded = file => file?.supersededByFiling && completed.has(file.originalPath ?? file.path);
  const filingRequested = work.draftRequested;
  const allowed = candidate.files.filter(file=>inScope(file) && !blocked.has(file.path) && !draftPaths.has(file.path) && !superseded(file) &&
    !(filingRequested && (file.kind === 'historical-source-original' || file.supersededByFiling)));
  const verifiedSources = intactSources.filter(item=>allowed.some(file=>file.path === item.path));
  const volumes = sourceVolumes(candidate.sourceMap,work.expected.includes('source'));
  const deliverables = requiredDelivery(work.expected,allowed,verifiedSources,volumes,work.mode,byPath,{...work,requireWord:true});
  const missingDeliverables = deliverables.flatMap(item=>item.missing);
  const missingDrafts = work.draftRequested ? deliverables.filter(item=>item.key !== 'source').flatMap(item=>item.missing) : [];
  const runtimeEvidence = reviewRuntimeEvidence(state, read,
    allowed.filter(file=>byPath.get(file.path)?.role==='manual'),reviewDetails);
  const runtimeSteps = runtimeEvidence.records.filter(record=>['部分已对照','步骤待补'].includes(record.status))
    .flatMap(record=>record.steps.map(step=>({step,record})));
  const featureCoverage = reviewInput ? null : work.features?.manuals.map(manual=>({
    path:manual.path,sha256:manual.sha256,features:manual.features.map(feature=>({
      ...feature,listed:work.features.names.some(row=>row.name === feature.name),
      steps:feature.steps.map(step=>{
        const matches = runtimeSteps.filter(({step:observed})=>['role','precondition','action'].every(key=>
          step[key] === observed[key]) && observed.locations.some(location=>location.path === manual.path ||
            allowed.some(file=>file.kind === 'filing-manual' && file.path === location.path &&
              file.evidence.some(ref=>ref.path === manual.path && ref.hash === manual.sha256))));
        const contradicted = matches.some(({step:observed})=>observed.expected !== step.expected || observed.status === '运行产物不符');
        const valid = !contradicted && matches.find(({step:observed})=>observed.status === '已对照');
        return {...step,resultStatus:contradicted ? '结果或证据不符' : valid ? '同版结果已对照' : '实际结果待补',
          ...(valid && {runtime:{record:valid.record.path,sha256:valid.record.sha256,
            locations:valid.step.locations,proof:valid.step.proof}})};
      }),
    })),
  }));
  const verifiedManuals = selfReview.reviews.filter(item=>allowed.some(file=>file.path === item.path));
  const verifiedFeatureActions = new Set(verifiedManuals.flatMap(manual=>manual.features
    .filter(feature=>feature.status === '同版结果已对照')
    .map(feature=>'找「'+feature.name+'」的同版依据')));
  const completeReview = selfReview.reviews.length > 0 && selfReview.unmatched.length === 0 &&
    selfReview.reviews.every(item=>verifiedManuals.includes(item) && item.status === '逐项结果已对照');
  const rows = report.rows.map(row => {
    const findings = issues.filter(issue=>issue.id === row.id);
    if (row.id === 'R3') return applicationRow(row,applicationCheck,findings);
    const pendingLayout = drafts.some(({file})=>(file.kind === 'uploaded-source-pdf' ||
      file.kind?.startsWith('source-') ? 'R4' : 'R6') === row.id);
    const quality = findings.length || pendingLayout ? 0 : row.quality;
    const missing = row.id === 'R1' ? missingDeliverables : row.id === 'R4' ?
      deliverables.find(item=>item.key === 'source')?.missing ?? [] : ['R6','R7'].includes(row.id) ? missingDrafts : [];
    if (missing.length) {
      const message = '本次应交材料缺项：'+missing.join('、')+'。';
      return {...row,quality:row.id === 'R6' ? 0 : Math.min(quality,0.5),formal:0,
        status:findings.length ? '退回' : '待补',evidence:row.evidence+' '+message,findings};
    }
    if (row.id === 'R5') return {...row,quality:work.draftRequested &&
      !allowed.some(file=>file.kind === 'filing-manual') && !verifiedManuals.length &&
      runtimeEvidence.matched === 0 ? 0 : selfReview.reviews.length &&
      !verifiedManuals.some(item=>item.status === '逐项结果已对照') ? Math.min(quality,0.5) : quality,
      formal:!findings.length && runtimeEvidence.status==='部分已对照' ? 0.5 : 0,
      status:findings.length ? '退回' : verifiedManuals.length ? verifiedManuals[0].status : runtimeEvidence.status,
      evidence:completeReview ? verifiedManuals.map(item=>item.detail).join(' ') : runtimeEvidence.detail,
      todo:completeReview ? '经办人确认拟申报范围及当期要求。' :
        '产品或开发核对被标记的步骤、运行版本和未覆盖的核心功能。',findings};
    if (row.id === 'R2') {
      const evidenceFound = Object.entries(versionCheck.groups).some(([key,items])=>
        key !== 'target' && items.some(item=>item.version));
      const conflict = candidate.conflict || findings.length || runtimeEvidence.versionConflict;
      const verifiedQuality = evidenceFound ? Math.max(quality,0.5) : quality;
      const evidence = versionCheck.questions.find(item=>item.conflict)?.detail ??
        (runtimeEvidence.versionConflict ? '终件复验发现实际运行版本冲突。' : row.evidence);
      return {...row,quality:conflict ? Math.min(verifiedQuality,0.5) : verifiedQuality,
        formal:conflict ? 0 : row.formal, status:conflict ? '退回' :
          versionCheck.status === 'pending' ? '待补' : phaseRow(verifiedQuality),
        evidence:versionSummary[versionCheck.status]+' '+evidence,
        todo:versionCheck.questions.map(item=>item.title).join('、') || row.todo,findings};
    }
    return {...row,quality,formal:findings.length || pendingLayout ? 0 : row.formal,
      status:findings.length ? '退回' : phaseRow(quality), findings};
  });
  const score = key => Math.round(rows.reduce((sum,row)=>sum+row[key],0)*1000/rows.length)/10;
  const extraActions = [
    {id:'R7',owner:'申请人',title:'核验现行表单及材料来源',detail:'在办理入口核对当期要求，确认本案材料的实际来源及适用声明。'},
    ...candidate.pending,
    ...coverageMissing.map(row=>({id:'R5',owner:'产品 / 开发',title:'核对功能「'+row.name+'」',
      detail:row.path+' 第 '+row.page+' 页第 '+row.line+' 行，待从同版说明书、实操及源码补齐依据。'})),
    ...applicationActions(applicationCheck),
    ...work.readingGaps.map(gap=>({id:'R6',owner:'文档整理人',title:gap.path,detail:gap.detail})),
    ...deliverables.filter(item=>item.missing.length).map(item=>({id:item.key === 'source' ? 'R4' : 'R6',
      owner:item.key === 'source' ? '开发方' : '文档整理人',title:item.title+'待补',detail:item.missing.join('、')})),
    ...(!completeReview ? [{id:'R5',owner:'产品 / 开发',title:'核对实操与待补范围',detail:runtimeEvidence.detail}] : []),
    ...drafts.filter(({file})=>file.kind?.endsWith('-pdf') || file.kind==='filing-manual').map(({file,reason})=>({
      id:['source-pdf','uploaded-source-pdf'].includes(file.kind) ? 'R4' : 'R6',owner:'开发方 / 文档整理人',title:'补齐交存材料 '+file.path,
      detail:reason+'请补同版原件后复验。'})),
    ...issues.map(issue=>({id:issue.id,owner:issue.id === 'R2' ? '开发方 / 经办人' : '开发方 / 文档整理人',
      title:issue.path,detail:issue.location+' '+issue.detail})),
  ];
  const approvedOriginals = new Map(allowed.map(file=>[file.originalPath ?? file.path,file]));
  const duplicatePaths = new Map(state.preflight.duplicates.map(file=>[file.path,file.original]));
  const sourceExclusions = new Map(work.sourceExclusions.map(item=>[item.path,item]));
  const disposition = state.entries.map(({path,hash,size})=>{
    const approved = approvedOriginals.get(path);
    if (approved?.hash === hash) return {path,hash,size,status:'经审核材料',bundlePath:'经审核材料/'+approved.path};
    const file = originalsByPath.get(path);
    const findings = issues.filter(issue=>issue.path === file?.path);
    const historicalSource = filingRequested && file?.kind === 'historical-source-original';
    const exclusion = sourceExclusions.get(path);
    const status = findings.length || historicalSource ? '待核原件' : '参考原件';
    const reason = findings.map(item=>item.location+' '+item.detail).join(' ') ||
      (historicalSource ? '仅有历史交存册，请补本次同版完整源码与行号映射。' :
        exclusion ? (exclusion.kind === 'third-party-copy' ? '随包第三方资料' : '随包生成产物')+'，出处 '+exclusion.evidence+'。' :
        approved ? '整理副本见经审核材料。' :
        superseded(file) ? '整理稿见经审核材料／申报准备。' :
        duplicatePaths.has(path) ? '与 '+duplicatePaths.get(path)+' 内容相同。' : '保留上传原件供核对。');
    return {path,hash,size,status,bundlePath:status+'/'+path,reason};
  });
  const retained = disposition.filter(file=>file.status !== '经审核材料');
  const criticalIssues = !!(drafts.length || missingDeliverables.length) || issues.some(item=>{
    const file = candidate.files.find(file=>file.path===item.path);
    return !superseded(file) && !(!reviewInput && item.id==='R4' && file?.kind==='uploaded-source-pdf' &&
      allowed.some(file=>file.kind==='source-pdf'));
  });
  const corrections = correctionStatus(state,allowed);
  const submission = submissionReadiness(state,{allowed,runtimeEvidence,verifiedSources,verifiedManuals,
    sourceVolumes:volumes,
    versionConflict:candidate.conflict || runtimeEvidence.versionConflict || !!versionCheck.questions.find(item=>item.conflict),
    criticalIssues:criticalIssues || corrections.some(item=>item.status!=='内部复核已记录')});
  const receipt = {caseId:state.id, revision, rules:ruleVersion, candidateId:candidate.id,
    inputStamp:state.inputStamp, auditedAt:new Date().toISOString(), allowed, drafts, blocked:[...blocked], retained, disposition, transcripts, replay,
    work:{...work,deliverables,missingDeliverables,missingDrafts},
    rows, issues, observations, layout, runtimeEvidence, draftingFacts:facts, versionCheck, applicationCheck, selfReview, featureCoverage, coverageMissing,
    verifiedSources,verifiedManuals,sourceVolumes:volumes,
    quality:score('quality'), formal:score('formal'), submission,corrections,filingReady:submission.ready,
    externalStatus:'无受理或登记回执', actions:[...report.actions.filter(item=>item.id !== 'R3' &&
      !(item.id === 'R5' && verifiedFeatureActions.has(item.title))),...extraActions]};
  return {...receipt, id:stamp(receipt)};
}

export function validateDownload(state, receiptId) {
  const audit = state.audit;
  if (state.stage !== 'audited' || !audit || !state.candidate || !state.preflight?.work || audit.id !== receiptId ||
      audit.rules !== ruleVersion || audit.caseId !== state.id || audit.revision !== state.revision ||
      audit.candidateId !== state.candidate.id || audit.inputStamp !== state.inputStamp ||
      audit.work?.id !== state.preflight.work.id || state.candidate.workId !== state.preflight.work.id) return false;
  const {id,...contents} = audit;
  return id === stamp(contents);
}
