import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archive, filingFont, root, runtime, JSZip } from './runtime.mjs';
import { digest } from './files.mjs';
import { sourceExtension } from './filing/source-scope.mjs';

const run = promisify(execFile);
const python = join(runtime, 'python/bin/python3');
const pinned = {
  repository:'https://github.com/IvanCodesDev/software-certificate-skill',
  commit:'ee7d4636f35210767adc0b5689f8678c68e6f7e6',
  archiveSha256:'4054d10eca3064a82e982bb82b982e339fee9e505197826dcf007e836681daef',
};
const sourceSkillHashes = {
  'common.py':'7697953a81713ffd3eb63f0d7f4eae67038b4df9aa9042ee0082f2618203fa31',
  'compose_code.py':'54374f9425f88ce8b8fc9206517bde50b7c838a8db96275127292c8ab64819e5',
  'render_code_pdf.py':'6d7cd792e62b8ce62af901103345ff93f6f9f27c832b6bac7a5da4457ae9e1ab',
};
export const sourceSkillPaths = Object.keys(sourceSkillHashes).map(name=>join(root,'app/filing/softcert-skill',name));
export const historicalReview = join(archive,'02 Microblog 开源实跑/软著Agent验证样本_仅测试.zip');
export const microblog = {
  archiveSha256:'70e3b910319ed3291096526b7e910ce4f2d93be88f6483c8820d0e211eadffdb',
  reviewedBundleSha256:'51c276b77dfa8240122176fbc87fcda1b3ffb44af52bc46ffea24d39e6ab8d2b',
  commit:'a975ef64864354867c88e0ed3a17ba7d17dca752',
  internalVersion:'V1.0',
  softwareName:'Microblog开源博客软件（质量验证样本）',
};

export async function sourceSelection(state, revised, blobs, omissions) {
  if (revised.authority) {
    const paths = revised.eligibleSource.filter(path => sourceExtension.test(path) && !omissions.has(path)).sort();
    if (paths.length) return {paths, softwareName:revised.authority.softwareName, version:revised.authority.version,
      basis:revised.authority.versionProof};
  }
  if (state.target?.snapshot !== microblog.commit) return null;
  const original = state.containers.find(file=>file.hash===microblog.archiveSha256);
  if (!original) return null;
  const reviewedBytes = await readFile(historicalReview).catch(error=>{
    if (error.code!=='ENOENT') throw error;
    return null;
  });
  if (!reviewedBytes) return null;
  if (digest(reviewedBytes) !== microblog.reviewedBundleSha256) throw new Error('Microblog 历史交存清单指纹不符。');
  const reviewed = await JSZip.loadAsync(reviewedBytes);
  const {files} = JSON.parse(await reviewed.file('证据/上游报告/代码来源追溯清单.json').async('string'));
  blobs.read(original);
  const current = new Map(state.entries.map(file=>[file.path,file]));
  if (!files.length || files.some(file=>current.get(file.path)?.hash!==file.sha256)) return null;
  return {paths:files.map(file=>file.path), softwareName:microblog.softwareName, version:state.target.version,
    basis:'固定开源提交 ' + microblog.commit + '。版本由本案确认，供内部复验。'};
}

async function tempJob(work) {
  const dir = await mkdtemp(join(tmpdir(), 'softcert-'));
  try { return await work(dir); }
  finally { await rm(dir, {recursive:true, force:true}); }
}

function runProcess(program, args, cwd, extraEnv = {}) {
  return run(program, args, {cwd, timeout:60_000, maxBuffer:1024 * 1024, env:{
    PATH:process.env.PATH, HOME:process.env.HOME, TMPDIR:tmpdir(), LANG:'en_US.UTF-8', ...extraEnv,
  }});
}

export async function composeSource(blobs, entries, selection) {
  return tempJob(async dir => {
    const input = join(dir,'source');
    const output = join(dir,'output');
    for (const path of sourceSkillPaths) {
      const name = basename(path);
      const bytes = await readFile(path);
      if (digest(bytes) !== sourceSkillHashes[name]) throw new Error('固定 Skill 指纹不一致：'+name);
      await writeFile(join(dir,name),bytes);
    }
    const renderer = join(dir,selection.pdfAdapter ? 'source-pdf-adapter.py' : 'render_code_pdf.py');
    if (selection.pdfAdapter) {
      await writeFile(renderer,await readFile(selection.pdfAdapter));
      for (const font of selection.sourceFonts) {
        await writeFile(join(dir,basename(font)),await readFile(font));
      }
    }
    for (const path of selection.paths) {
      const target = join(input,path);
      await mkdir(dirname(target), {recursive:true});
      await writeFile(target, blobs.read(entries.find(file => file.path === path)));
    }
    const manifest = join(dir,'manifest.json');
    const facts = join(dir,'facts.json');
    await writeFile(manifest,JSON.stringify({ordered_files:selection.paths,review:{basis:selection.basis},
      line_exclusions:selection.web?.lineExclusions ?? []}));
    await writeFile(facts,JSON.stringify({software_full_name:selection.softwareName,version:selection.version}));
    const composer = join(dir,'source-adapter.py');
    for (const script of ['source-adapter.py','pagination.py']) {
      await writeFile(join(dir,script),await readFile(join(root,'app/filing',script)));
    }
    const compose = async (destination, compact = false) => {
      await runProcess(python,[composer,'--project',input,'--manifest',manifest,
        '--facts',facts,'--output-dir',destination,
        ...(selection.linesPerPage ? ['--lines-per-page',String(selection.linesPerPage)] : []),
        ...(compact ? ['--compact-layout'] : [])],dir);
      const path = join(destination,'source-provenance.json');
      return {path, map:JSON.parse(await readFile(path,'utf8')),capacity:compact ? 76 : 66};
    };
    let layout = await compose(output);
    if (layout.map.rows_per_page > layout.capacity) {
      const compact = await compose(join(dir,'compact'),true);
      if (compact.map.rows_per_page <= compact.capacity) layout = compact;
    }
    const {map:provenance,path:provenancePath,capacity} = layout;
    const inputs = new Map(entries.map(file=>[file.path,file.hash]));
    if (provenance.files.length !== selection.paths.length ||
        provenance.files.some((file,index)=>file.path !== selection.paths[index] || file.sha256 !== inputs.get(file.path))) {
      throw new Error('排版清单与本次选中的源文件或指纹不一致。');
    }
    const files = [];
    const add = async (file, path, extra) => files.push({path, ...blobs.put(await readFile(file)), ...extra});
    let wrapExamples = '';
    if (provenance.rows_per_page > capacity) {
      const longest = new Map();
      for (const line of provenance.line_mapping) {
        const key = `${line.file}:${line.source_line}`;
        if (line.segment > (longest.get(key) ?? 2)) longest.set(key,line.segment);
      }
      wrapExamples = [...longest].sort((a,b)=>b[1]-a[1]).slice(0,3)
        .map(([key,rows])=>`${key}（折为 ${rows} 行）`).join('、');
    }
    for (const [volume, group] of Object.entries(provenance.filing_groups)) {
      const label = {all:'全部',front_30:'前30页',back_30:'后30页'}[volume];
      const pdf = join(output,volume+'.pdf');
      const report = join(output,volume+'-render.json');
      if (provenance.rows_per_page > capacity) {
        files.push({volume, omitted:'源码交存 PDF（'+label+'）待核。当前源码连续分页需要每页最多 '+provenance.rows_per_page+
          ' 行显示空间，常规与紧凑版式均未能满足。'+(wrapExamples ? '折行较多的原件位置包括 '+wrapExamples+'。' : '')+
          '请开发方依据同版原件核定交存范围及可采用的排版方式。'});
      } else {
        try {
          await runProcess(python,[renderer,'--provenance',provenancePath,
            '--facts',facts,'--volume',volume,'--pdf',pdf,'--report',report,'--expected-pages',String(group.page_count)],
            dir,selection.pdfAdapter ? {SOFTCERT_SOURCE_FILING_FONT:filingFont} : {});
          await add(pdf,'交存源码－'+label+'.pdf',{kind:'source-pdf',volume,expectedPages:group.page_count});
        } catch (error) {
          console.error('交存 PDF 生成失败', String(error.stderr || error.message).slice(0, 900));
          files.push({volume, omitted:'源码交存 PDF（'+label+'）生成失败，需重新排版。'});
        }
      }
      await add(provenance.artifacts[volume+'_docx'].path,'交存源码－'+label+'.docx',{kind:'source-docx',volume});
    }
    const map = {...provenance,software_name:selection.softwareName,version:selection.version,upstream:pinned,
      ...(selection.packageName && selection.packageName !== selection.softwareName && {package_name:selection.packageName}),
      ...(selection.entrypoints?.length && {runtime_entrypoints:selection.entrypoints}),
      ...(selection.pythonDistribution && {python_distribution_scope:selection.pythonDistribution}),
      ...(selection.web && {runtime_resource_scope:{
        archiveSha256:selection.web.archiveSha256,proof:selection.web.proof,
        files:selection.web.decisions,supplements:selection.web.supplements,
        ...(selection.web.commit && {commit:selection.web.commit,lineExclusions:selection.web.lineExclusions}),
      }}),
      ...(selection.sourceSnapshot && {source_snapshot:selection.sourceSnapshot})};
    delete map.project_root;
    delete map.manifest;
    for (const artifact of Object.values(map.artifacts)) artifact.path = basename(artifact.path);
    for (const file of map.files) {
      delete file.absolute_path;
    }
    return {files, map, upstream:pinned};
  });
}

export async function renderManual(blobs, file) {
  return tempJob(async dir => {
    const input = join(dir,'manual.docx');
    const bytes = blobs.read(file);
    const docx = await JSZip.loadAsync(bytes);
    const entries = Object.values(docx.files).filter(item=>!item.dir);
    if (entries.reduce((total,item)=>total+item._data.uncompressedSize,0)>48*1024*1024) {
      throw new Error('Word 解包超出导出限制。');
    }
    for (const item of entries.filter(item=>/\.rels$/i.test(item.name))) {
      if (/\bTargetMode\s*=\s*["']External["']/i.test(await item.async('string'))) {
        throw new Error('Word 含外部链接，请使用无外部引用的副本导出 PDF。');
      }
    }
    await writeFile(input,bytes);
    const profile = '-env:UserInstallation='+pathToFileURL(join(dir,'profile')).href;
    const fonts = join(dir,'fonts.conf');
    await writeFile(fonts,`<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/System/Library/Fonts</dir>
  <dir>/System/Library/Fonts/Supplemental</dir>
  <dir>/Library/Fonts</dir>
  <cachedir>${join(dir,'font-cache')}</cachedir>
  <alias><family>SimSun</family><prefer><family>Songti SC</family></prefer></alias>
  <alias><family>Microsoft YaHei</family><prefer><family>Heiti SC</family></prefer></alias>
  <alias><family>Consolas</family><prefer><family>Menlo</family></prefer></alias>
</fontconfig>`);
    await runProcess(join(runtime,'bin/override/soffice'),
      [profile,'--headless','--convert-to','pdf','--outdir',dir,input],dir,{FONTCONFIG_FILE:fonts});
    return {path:'导出PDF/'+file.path.replace(/\.docx$/i,'.pdf'),
      ...blobs.put(await readFile(join(dir,'manual.pdf'))),kind:'manual-pdf',from:file.path};
  });
}


export async function renderFilingManual(renderer, markdown, name, version, illustrations = []) {
  return tempJob(async dir => {
    const contents = join(dir,'manual.md');
    const output = join(dir,'filing-manual.pdf');
    await writeFile(contents,markdown);
    const images = [];
    for (const [index, bytes] of illustrations.entries()) {
      const image = join(dir,'figure-'+(index+1));
      await writeFile(image,bytes);
      images.push(image);
    }
    const {stdout} = await runProcess(python,[renderer,contents,output,name,version,...images],dir);
    return {bytes:await readFile(output), layout:JSON.parse(stdout)};
  });
}

export async function renderEditableWord(writer, markdown, illustrations = []) {
  return tempJob(async dir=>{
    const contents = join(dir,'draft.md');
    const output = join(dir,'draft.docx');
    await writeFile(contents,markdown);
    const images = [];
    for (const [index,bytes] of illustrations.entries()) {
      const image = join(dir,'figure-'+(index+1));
      await writeFile(image,bytes);
      images.push(image);
    }
    await runProcess(python,[writer,contents,output,...images],dir);
    return readFile(output);
  });
}
