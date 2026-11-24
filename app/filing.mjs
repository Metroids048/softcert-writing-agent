import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filingFont, root } from './runtime.mjs';
import { renderEditableWord, renderFilingManual } from './compose.mjs';
import { buildFilingDraft, packageFacts } from './filing/evidence.mjs';
import { localizeEnglish } from './filing/localize.mjs';
export { selfReviewInput } from './filing/self-review.mjs';
import { selectReviewedSource } from './filing/self-review.mjs';
import { embeddedWebResources, sourceExtension } from './filing/source-scope.mjs';
import { digest } from './files.mjs';
import { guiFigures } from './runtime-evidence.mjs';
import { packagedWebAssets, resolvePackagedWeb, resolveStaticWeb } from './filing/packaged-web.mjs';

const dir = join(root,'app/filing');
const sourceJson = readFileSync(join(dir,'fixed-source.json'));
const profile = JSON.parse(sourceJson);
const renderer = join(dir,'render-manual.py');
const writer = join(dir,'write-word.py');
const pdfAdapter = join(dir,'source-pdf-adapter.py');
const sourceFonts = ['NotoEmoji.ttf','NotoSansSymbols2-Regular.ttf'].map(name=>join(dir,'fonts',name));
export function selectSelfPreparedSource(state,input,read) {
  const selection = selectReviewedSource(state,input,read);
  return selection && {...selection,pdfAdapter,sourceFonts};
}
export const filingAssetPaths = ['filing.mjs','filing/evidence.mjs','filing/layout.mjs','filing/localize.mjs','filing/ocr-evidence.mjs','filing/manual-claims.mjs','filing/manual-tables.mjs','filing/manual-continuations.mjs','filing/measurements.mjs','filing/table-references.mjs','filing/feature-evidence.mjs','filing/source-scope.mjs']
  .map(path=>join(root,'app',path)).concat(packagedWebAssets,renderer,writer,pdfAdapter,sourceFonts,filingFont,
    ...['fixed-source.json','source-adapter.py','pagination.py','translate.py'].map(path=>join(dir,path)));

export function fixedSourceProfile(state) {
  const {source} = profile;
  if (state.containers.some(file=>file.hash===source.archiveSha256) &&
      source.files.every(({path,sha256})=>state.entries.some(file=>file.path===path && file.hash===sha256 &&
        file.container?.hash===source.archiveSha256))) return profile;
}

export function selectFilingSource(state, blobs) {
  const fixed = fixedSourceProfile(state);
  if (!fixed || state.target?.snapshot !== fixed.source.commit || state.target.version !== fixed.version) return null;
  const {source, name:softwareName, version} = fixed;
  blobs.read(state.containers.find(file=>file.hash===source.archiveSha256));
  return {paths:source.files.map(file=>file.path),softwareName,version,pdfAdapter,sourceFonts,linesPerPage:51,sourceSnapshot:{
    repository:source.repository,commit:source.commit,archiveSha256:source.archiveSha256,
    adapter:'固定清单中的 Shell 文件按普通源码文本纳入排版',
  },basis:'申请版本 '+version+' 已在本案确认。按上游 '+source.commit+' 的选定文件清单排序；来源 '+source.repository+'。'};
}

export function selectPackagedSource(state, report, details, omissions, blobs, staticRelease) {
  if (!state.target?.confirmedAt) return null;
  const matching = packageFacts(details,new Map(state.entries.map(entry=>[entry.path,entry])))
    .filter(release=>release.version === state.target.version);
  const staticWeb = !matching.length && staticRelease?.version === state.target.version ? staticRelease : null;
  if (staticWeb) matching.push(staticWeb);
  if (matching.length !== 1) return null;
  const [{name:softwareName,version,path,environment,versionLine}] = matching;
  const manifest = state.entries.find(item=>item.path === path);
  const prefix = path.slice(0,path.lastIndexOf('/')+1);
  const {html,web,sourcePending} = (staticWeb ? resolveStaticWeb(staticWeb) :
    resolvePackagedWeb(state,blobs,manifest,prefix,softwareName,version)) ?? {html:[]};
  if (sourcePending) return {softwareName,version,entrypoints:[],sourcePending};
  const runtimePaths = new Set(staticWeb ? web.decisions.map(item=>prefix+item.path) : html);
  const excluded = /^(?:\.|node_modules$|vendor$|third[_-]?party$|tests?$|__tests__$|fixtures?$|examples?$|docs?$|dist$|build$|benchmarks?$|thirdparty$)/iu;
  const paths = state.entries.filter(file=>manifest?.container && file.container?.hash === manifest.container.hash &&
    file.path.startsWith(prefix) && !file.path.slice(prefix.length).split('/').some(part=>excluded.test(part)) &&
    !omissions.has(file.path) && !/(?:^|[._-])(?:test|spec|min)[._-]/iu.test(file.path.split('/').at(-1)) &&
    file.size && (report.files.some(item=>item.path === file.path && item.role === 'source') ||
      runtimePaths.has(file.path) || /\.(?:css|scss|sass|less)$/iu.test(file.path)) && sourceExtension.test(file.path))
    .map(file=>file.path).sort();
  const entrypoints = staticWeb ? html.filter(path=>paths.includes(path)) : paths.filter(path=>html.includes(path));
  const selected = [...entrypoints,...(web?.supplements.map(file=>file.path) ?? []),...paths.filter(path=>!html.includes(path))];
  if (web?.decisions.some(row=>row.path && selected.includes(prefix+row.path) !== (row.decision === '纳入') &&
      (row.decision === '纳入' || row.path === row.url.slice(1)))) {
    throw new Error('源码范围未消费已核对的运行资源决定。');
  }
  if (staticWeb) {
    const entries = new Map(state.entries.map(file=>[file.path,file]));
    web.lineExclusions = embeddedWebResources(entrypoints.map(path=>entries.get(path)),blobs.read);
  }
  const pythonDistribution = versionLine && {path,prefix,versionLine,environment,
    archiveSha256:manifest.container.hash,manifestSha256:manifest.hash,
    files:state.entries.filter(file=>file.container?.hash === manifest.container.hash && file.path.startsWith(prefix))
      .map(file=>{
        const relative = file.path.slice(prefix.length);
        const included = selected.includes(file.path);
        const omission = omissions.get(file.path);
        const reason = included ? (/^setup\.py$/iu.test(relative) ? '发行构建脚本' : '程序源码') :
          omission ? omission.kind+'，依据 '+omission.evidence : (
            /(?:^|\/)tests?(?:\/|[_.-])/iu.test(relative) ? '测试材料' :
            /(?:^|\/)docs?\/|\.rst$|\.md$/iu.test(relative) ? '文档或说明' :
            /\.egg-info\/|(?:^|\/)PKG-INFO$/iu.test(relative) ? '发行元数据' :
            /\.pyi$/iu.test(relative) ? '仅供类型检查的存根' :
            /\.json$/iu.test(relative) ? '数据或配置文件，无程序正文' :
            !file.size ? '无程序正文的空文件' : '其他发行辅助材料');
        return {path:file.path,sha256:file.hash,decision:included ? '纳入' : '排除',reason};
      })};
  if (selected.length) return {paths:selected,softwareName,version,pdfAdapter,sourceFonts,linesPerPage:51,
    entrypoints,...(web && {web}),
    ...(pythonDistribution && {pythonDistribution}),
    basis:versionLine ? '确认版次与 '+path+' 第 '+versionLine+' 行一致。交存同一源码发行包的应用程序及构建脚本。排除测试、文档、生成的发行元数据、类型存根及仅供代码读取的数据文件；原件仍随案留存。' :
      '确认版次与 '+path+' 一致。交存同源归档下的非空程序文本及本案核准的补充源码；同版浏览器记录证实的 HTML 优先排版。排除常见测试、示例、依赖及生成目录。'};
}

export async function composeFilingDocuments(blobs, selection, inspected, entries, expected, warnings, sourceMap, applicationCheck, features, operations, omissions, runtimeInputs = entries, {manualPdfOnly=false,sameReleaseManuals=[],launch=[]}={}) {
  const draft = await buildFilingDraft(selection,inspected,entries,warnings,sourceMap,blobs.read,
    (values,identifiers)=>localizeEnglish(dir,root,values,identifiers),applicationCheck,features,operations,omissions,sameReleaseManuals,launch);
  if (!draft?.evidence.length) return null;
  const {name,version,evidence,form,manual,checklist,ocrReport,materialGaps} = draft;
  const prefix = '申报准备/';
  const write = (path,kind,bytes,extra={})=>({path:prefix+path,kind,evidence,...extra,...blobs.put(Buffer.from(bytes))});
  const files = [
    write('申请人补件清单.md','filing-checklist',checklist),
  ];
  const editableManual = manual + (materialGaps.length ?
    '\n## 待核与待补\n\n'+materialGaps.map(gap=>'- '+gap).join('\n')+'\n' : '');
  const illustrations = expected.includes('manual') ? guiFigures(operations).map(ref=>{
    const original = runtimeInputs.find(file=>file.path === ref.path && file.hash === ref.sha256);
    if (!original) throw new Error('实操截图无法回查原件：'+ref.path);
    return blobs.read(original);
  }) : [];
  const outputGaps = [];
  const editable = async (path,kind,markdown,images=[])=>{
    try {
      files.push(write(path+'.docx',kind,await renderEditableWord(writer,markdown,images),
        {from:prefix+path+'.md',figures:images.map(digest)}));
    } catch (error) {
      console.error('Word 生成失败',String(error.stderr || error.message).slice(0,900));
      outputGaps.push('未能生成 '+path+'.docx，保留现有底稿供检查。');
    }
  };
  if (expected.includes('form')) {
    files.push(write('申请表底稿.md','filing-form',form));
    await editable('申请表底稿','filing-form-word',form);
  }
  if (expected.includes('manual')) {
    files.push(write('说明书正文.md','filing-manual-text',editableManual));
    if (!manualPdfOnly) await editable('说明书正文','filing-manual-word',editableManual,illustrations);
  }
  if (ocrReport) files.push(write('OCR 命令与路径校对.md','filing-ocr',ocrReport));
  if (draft.measurements) files.push(write('实测数字来源对照.md','filing-measurements',draft.measurements));
  if (draft.tables) files.push(write('图表引用索引.md','filing-tables',draft.tables));
  if (expected.includes('manual') && draft.hasBody) {
    const rendered = await renderFilingManual(renderer,manual,name,version,illustrations);
    files.push(write('说明书.pdf','filing-manual',rendered.bytes,{layout:rendered.layout,gaps:draft.missing}));
  }
  return {superseded:draft.superseded,files,materialGaps:[...outputGaps,...(expected.includes('manual') ? materialGaps : [])]};
}
