import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { recognizeScan } from './scan-ocr.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const runtime = process.env.SOFTCERT_RUNTIME || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
export const archive = process.env.SOFTCERT_CASE_ARCHIVE || join(root, '归档');
const requireRuntime = createRequire(join(runtime, 'node/node_modules/resolve.cjs'));
export const JSZip = requireRuntime('jszip');
export const { chromium } = requireRuntime('playwright');
export const chrome = process.env.SOFTCERT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const readerDirectory = join(root, 'app/filing/reader');
const pdfDirectory = join(requireRuntime.resolve('pdfjs-dist/package.json'), '..', 'build');
const pdfPageLimit = 240;
export const readerPaths = [join(readerDirectory,'checks.js'),join(readerDirectory,'auto-revise.js'),
  join(pdfDirectory,'pdf.min.mjs'),join(pdfDirectory,'pdf.worker.min.mjs'),requireRuntime.resolve('jszip/dist/jszip.min.js')];
const [readerFile,reviserFile,pdfModuleFile,pdfWorkerFile,zipFile] = readerPaths;
const frozenReader = readFileSync(readerFile,'utf8');
const oldReadRange = 'Math.min(doc.numPages,100)';
if (frozenReader.split(oldReadRange).length !== 2) throw new Error('归档 PDF 读取入口变化，请复核读取范围。');
const reader = frozenReader.replace(oldReadRange,'Math.min(doc.numPages,'+pdfPageLimit+')')
  .replace('已读取前 100 页。','已读取前 '+pdfPageLimit+' 页。');
const reviser = readFileSync(reviserFile,'utf8');
const pdfScripts = [['module',pdfModuleFile],['worker',pdfWorkerFile]].map(([kind,path])=>
  `<script id="pdf-${kind}" type="text/plain">${readFileSync(path,'utf8')}</script>`);
const zipScript = readFileSync(zipFile,'utf8');
const model = process.env.SOFTCERT_TRANSLATION_MODEL || join(root,'.workbench/translation/translate-en_zh-1_9');
export const filingFont = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
const dependencies = {
  node:process.execPath, chrome, python:join(runtime,'python/bin/python3'), swift:'/usr/bin/swift',
  libreOfficeLauncher:join(runtime,'bin/override/soffice'),
  libreOffice:join(runtime,'native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice'),
  translationPython:process.env.SOFTCERT_TRANSLATION_PYTHON || join(root,'.workbench/translation-venv/bin/python'),
  translationTokenizer:join(model,'sentencepiece.model'), translationWeights:join(model,'model/model.bin'),
  translationModelConfig:join(model,'model/config.json'),
  translationVocabulary:join(model,'model/shared_vocabulary.json'),
  filingFont,
  macFonts:'/System/Library/Fonts/Supplemental', localFonts:'/Library/Fonts',
};
function installed(file) {
  try {
    const path = realpathSync(file);
    const {size,mtimeMs} = statSync(path);
    return {path,size,mtimeMs};
  } catch (error) {
    if (error.code!=='ENOENT') throw error;
    return {path:file,missing:true};
  }
}
export function runtimeIdentity() {
  const python = join(runtime,'python/lib');
  const pythonLibraries = readdirSync(python).filter(name=>/^python\d+\.\d+$/u.test(name)).flatMap(name=>{
    const packages = join(python,name,'site-packages');
    return readdirSync(packages).filter(directory=>/^(?:lxml|pillow|pypdf|python_docx|reportlab)-.*\.dist-info$/iu.test(directory))
      .map(directory=>[directory,installed(join(packages,directory,'METADATA'))]);
  });
  return {root:runtime,node:process.version,sqlite:process.versions.sqlite,pdfPageLimit,
    libraries:Object.fromEntries(['jszip','playwright','playwright-core'].map(name=>{
      const path = requireRuntime.resolve(name+'/package.json');
      return [name,{version:JSON.parse(readFileSync(path)).version,manifest:installed(path)}];
    })),
    pythonLibraries:Object.fromEntries(pythonLibraries),
    dependencies:Object.fromEntries(Object.entries(dependencies).map(([name,file])=>[name,installed(file)]))};
}
let browser;

export async function inspectFiles(origin, items, mode, withLayout=false, writablePaths=null) {
  browser ??= chromium.launch({ executablePath: chrome, headless: true }).then(active => {
    active.once('disconnected', () => { browser = undefined; });
    return active;
  }).catch(error => {
    browser = undefined;
    throw error;
  });
  const active = await browser;
  const context = await active.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => route.request().url() === origin + '/worker' ? route.continue() : route.abort());
    const page = await context.newPage();
    const inputs = new Map(items.map(item=>[item.path,item.bytes]));
    await page.exposeFunction('recognizeScan',(path,hash,pages)=>recognizeScan(inputs.get(path),hash,pages));
    await page.goto(origin + '/worker');
    await page.setContent('<meta charset="utf-8">' + pdfScripts.join(''));
    await page.addScriptTag({ content: zipScript });
    await page.addScriptTag({ content: reader + '\n' + (mode === 'review' ? '' : reviser) });
    return await page.evaluate(async ({ items, mode, withLayout, pdfPageLimit, writablePaths }) => {
      const files = items.map(({path, data}) => ({
        path, bytes: Uint8Array.fromBase64(data),
        role: /(?:^|\/)(?:源程序|.*-代码\(|交存源码)/.test(path) ||
          /^(?:程序|源程序)鉴别材料(?:[（( _-].*)?\.pdf$/iu.test(path.split('/').at(-1)) ?
          'source' : category(path),
      }));
      for (const file of files) {
        await inspect(file);
        if (file.role === 'other' && /\.(?:md|txt)$/i.test(file.path)) {
          const fields = file.pages?.[0]?.lines.map(line=>line.replace(/^[\s|#*-]+/u,'').replaceAll('**','')) ?? [];
          const labelled = pattern=>fields.some(line=>pattern.test(line));
          if (labelled(/^(?:软件全称|软件名称)\s*[:：|]\s*[^|\s]/u) &&
              labelled(/^(?:软件版本(?:号)?|版本号)\s*[:：|]\s*v?\d+(?:\.\d+){1,3}\s*(?:\||$)/iu) &&
              (/(?:登记|申请).{0,8}(?:表|填报)|(?:登记|申请)清单/u.test(file.path.split('/').at(-1)) ||
                labelled(/^(?:著作权人|开发完成日期|首次发表日期)\s*[:：|]/u))) file.role = 'form';
        }
        if (file.role === 'manual' && /\.tex$/iu.test(file.path)) {
          try {
            const lines = new TextDecoder('utf-8',{fatal:true}).decode(file.bytes).split(/\r?\n/u);
            let body = false;
            let skipped = null;
            const extracted = lines.map(source=>{
              const line = source.trim().replace(/(?<!\\)%.*$/u,'');
              const environment = /^\\(begin|end)\{([\w*]+)\}/u.exec(line);
              if (environment) {
                const [,verb,kind] = environment;
                if (kind === 'document') body = verb === 'begin';
                else if (skipped === kind && verb === 'end') skipped = null;
                else if (!skipped && verb === 'begin' && !['enumerate','itemize'].includes(kind)) skipped = kind;
                return '';
              }
              if (!body || skipped) return '';
              const value = line.replace(/^\\(subsection|section|subsubsection)\*?\{([^{}]+)\}$/u,
                (_,level,title)=>({section:'##',subsection:'###',subsubsection:'####'})[level]+' '+title)
                .replace(/^\\item\s+/u,'- ')
                .replace(/\\(?:texttt|textbf|emph|code|mathrm)\{([^{}]+)\}/gu,'$1')
                .replace(/\\([%_&#$])/gu,'$1');
              return /\\/u.test(value) ? '' : value;
            });
            if (extracted.some(Boolean)) {
              file.pages = [{lines:extracted}];
              delete file.unreadable;
            }
          } catch { /* Preserve the original as unreadable if it is not UTF-8 text. */ }
        }
        if (/(?:^|\/)(?:pyproject\.toml|PKG-INFO|(?:LICEN[CS]E|COPYING|NOTICE)(?:\.(?:txt|md|rst))?)$/i.test(file.path)) {
          try {
            file.pages = [{lines:new TextDecoder('utf-8',{fatal:true}).decode(file.bytes).split(/\r?\n/)}];
            delete file.unreadable;
          } catch { /* Leave the unreadable result for the original. */ }
        }
      }
      const data = { files, skipped: [], originalCount: files.length };
      const scanFiles = files.filter(file=>/\.pdf$/i.test(file.path) && file.pages &&
        (['manual','form'].includes(file.role) || mode === 'preflight' &&
          ['identity','rights','declaration'].includes(file.role)));
      const hanCount = text => (text.match(/\p{Script=Han}/gu) ?? []).length;
      const chineseForm = files.some(file=>file.role === 'form' &&
        file.pages?.some(page=>hanCount(page.lines.join(' ')) > 40));
      const ocrByPath = new Map();
      for (const file of scanFiles) {
        const targets = file.pages.flatMap((page,index)=>{
          const text = page.lines.join(' ');
          const unusual = text.match(/[\p{Script=Nko}\p{Script=Mandaic}\p{Script=Hangul}]/gu) ?? [];
          const corrupt = /[\p{Script=Nko}\p{Script=Mandaic}]/u.test(text) && unusual.length > text.length*.18;
          const missing = !page.lines.some(line=>line.trim() && !/^(?:第\s*)?\d+(?:\s*页)?$/u.test(line.trim()));
          const han = hanCount(text);
          const required = corrupt || missing;
          return required || file.role === 'manual' && chineseForm && han < 18 ?
            [{number:index+1,required,han}] : [];
        });
        if (!targets.length) continue;
        const result = await window.recognizeScan(file.path,file.hash,targets.map(item=>item.number));
        const recovered = (result ?? []).filter(({page,lines})=>{
          const target = targets.find(item=>item.number === page);
          const text = lines.join(' ');
          return target?.required ? (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 16 :
            target && hanCount(text) >= Math.max(18,target.han+10);
        });
        const unresolved = targets.filter(item=>item.required &&
          !recovered.some(page=>page.page === item.number)).map(item=>item.number);
        if (recovered.length || unresolved.length) {
          ocrByPath.set(file.path,{hash:file.hash,pages:recovered,unresolved,unavailable:result === null});
        }
      }
      // Plan the existing safe edits against original text, without writing in preflight.
      const originalAuthority = ['preflight','readonly-preparation'].includes(mode) ? releaseAuthority(files, assess(data)) : null;
      const versionEdits = originalAuthority ? files.filter(file=>['form','manual'].includes(file.role) &&
        /\.(?:docx|txt)$/i.test(file.path)).flatMap(file=>planDraftEdits(file,originalAuthority,new Map())
          .filter(edit=>edit.after.includes(originalAuthority.version))) : [];
      // Keep OCR out of the authoritative inputs to automatic write-back.
      if (mode !== 'revise') {
        for (const file of scanFiles) {
          const ocr = ocrByPath.get(file.path);
          if (!ocr) continue;
          for (const {page,lines} of ocr.pages) file.pages[page-1].lines = lines;
          file.blank = ocr.unresolved.length;
        }
      }
      const report = assess(data);
      const details = files.map(file => ({path:file.path, pages:file.pages, ocr:ocrByPath.get(file.path)}));
      if (withLayout) {
        for (const file of files.filter(item=>item.pageCount && (['manual','form'].includes(item.role) || mode !== 'preflight' && item.role === 'source'))) {
          const api = await pdfApi();
          const task = api.getDocument({data:file.bytes.slice(),isEvalSupported:false});
          try {
            const pdf = await task.promise;
            const layout = [];
            for (let index=1; index<=Math.min(pdf.numPages,pdfPageLimit); index++) {
              const page = await pdf.getPage(index);
              const viewport = page.getViewport({scale:1});
              const content = await page.getTextContent();
              const items = content.items.filter(item=>item.str?.trim()).map(item=>{
                const [x,y] = viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
                return {x,right:x+item.width,y:viewport.height-y,text:item.str};
              });
              layout.push({width:viewport.width,height:viewport.height,items});
            }
            details.find(detail=>detail.path===file.path).layout = layout;
          } finally { await task.destroy(); }
        }
      }
      for (const file of report.files) {
        if (file.pageCount) file.readPages = details.find(detail=>detail.path===file.path).pages?.length ?? 0;
        const ocr = ocrByPath.get(file.path);
        if (ocr) file.ocr = {pages:ocr.pages.map(item=>item.page),unresolved:ocr.unresolved,unavailable:ocr.unavailable};
      }
      if (mode === 'review') {
        for (const file of files.filter(item=>item.path.startsWith('历史研究/') && /整理版.*\.pdf$/i.test(item.path) && item.pageCount)) {
          const api = await pdfApi();
          const documentTask = api.getDocument({data:file.bytes.slice(),isEvalSupported:false});
          try {
            const pdf = await documentTask.promise;
            const toc = await pdf.getPage(1);
            const links = (await toc.getAnnotations()).filter(annotation=>annotation.subtype === 'Link');
            const destinations = await Promise.all(links.map(async link => {
              const destination = typeof link.dest === 'string' ? await pdf.getDestination(link.dest) : link.dest;
              return Array.isArray(destination) && destination[0] ? (await pdf.getPageIndex(destination[0]))+1 : null;
            }));
            details.find(detail=>detail.path===file.path).destinations = destinations;
          } finally { await documentTask.destroy(); }
        }
      }
      const authority = mode === 'revise' ? releaseAuthority(files, report) : originalAuthority;
      const eligibleSource = authority ? files.filter(file=>codePattern.test(file.path) && file.pages &&
        file.path.startsWith(authority.manifestPath.slice(0, -'release.json'.length))).map(file=>file.path) : [];
      if (mode !== 'revise') return {report,details,versionEdits,authority,eligibleSource};
      const result = await autoRevise(data, report);
      const writable = writablePaths && new Set(writablePaths);
      const detectedConflict = report.rows.some(row => row.id === 'R2' && row.formal === 0 && /冲突/.test(row.evidence)) ||
        report.actions.some(action => ['处理版本冲突','核对软件全称'].includes(action.title));
      const remainingConflict = result.after.actions.some(action => ['处理版本冲突','核对软件全称'].includes(action.title));
      return {
        report, authority, detectedConflict, remainingConflict, changes: result.changes.filter(change=>!writable || writable.has(change.path)),
        scans: [...ocrByPath.entries()],
        details:details.filter(item=>['form','manual'].includes(files.find(file=>file.path===item.path).role) ||
          /(?:^|\/)(?:pyproject\.toml|package\.json|PKG-INFO)$/i.test(item.path)),
        deferred: result.deferred, reason: result.reason,
        edits: [...result.files.values()].filter(file=>!writable || writable.has(file.path)).map(file => ({path:file.path, data:file.bytes.toBase64()})),
        eligibleSource,
      };
    }, { items: items.map(item => ({path:item.path, data:item.bytes.toString('base64')})), mode, withLayout, pdfPageLimit, writablePaths });
  } finally {
    await context.close();
  }
}

export async function closeWorker() {
  if (browser) await (await browser).close();
}
