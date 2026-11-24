import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium, chrome, JSZip, root} from '../runtime.mjs';
import {digest} from '../files.mjs';

const evidence = join(root, '运行证据');
const destination = process.argv[2];
assert.ok(destination, 'An evidence directory is required');
const inputs = join(evidence, 'v0.3.21-中文新案双测-2026-11-23');
const retainedData = process.env.SOFTCERT_VERIFY_DATA;
const data = retainedData ?? await mkdtemp(join(tmpdir(),'softcert-dual-'));
await mkdir(data,{recursive:true});
const server = spawn(join(root,'app/start.sh'),[],{
  env:{...process.env,SOFTCERT_PORT:'0',SOFTCERT_DATA:data}, stdio:['ignore','pipe','inherit'],
});
const deadline = setTimeout(()=>server.kill(),15000);
const [chunk] = await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Server exited');})]);
clearTimeout(deadline);
const origin=chunk.toString().trim();
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/u);
const browser = await chromium.launch({executablePath:chrome,headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1050}});
const cases = [
  ['亲戚关系计算器','中国亲戚关系计算器',['前30页','后30页'],4],
  ['Vditor','Vditor 中文 Markdown 编辑器',['前30页','后30页'],3],
];
const archivedCases = {
  '亲戚关系计算器':'c1b79543-2b00-4db8-b62d-f42ee6d408f5',
  Vditor:'310c3758-cbf5-4044-b2ea-81aef4836ca9',
};
const collect=async (page, suffix, click, method='POST')=>{
  const received=page.waitForResponse(response=>response.request().method()===method &&
     new URL(response.url()).pathname.endsWith(suffix),{timeout:240000});
  await click();
  const response=await received;
  assert.equal(response.status(),200,await response.text());
  await page.locator('#notice').waitFor({state:'hidden',timeout:240000});
  return response.json();
};
const save=async (page, label, target)=>{
  const [download]=await Promise.all([
    page.waitForEvent('download',{timeout:120000}),page.getByRole('link',{name:label,exact:true}).click(),
  ]);
  assert.equal(await download.failure(),null);
  await download.saveAs(target);
  return readFile(target);
};
const results=[];
try {
  for(const [key,name,volumes,figureCount] of cases) {
    if(process.env.SOFTCERT_ONLY && process.env.SOFTCERT_ONLY!==key) continue;
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const target=join(destination,key);
    const files=join(target,'实际下载');
    await mkdir(files,{recursive:true});
    const input=JSON.parse(await readFile(join(inputs,key,'冻结上传.json'),'utf8'));
    const uploads=[];
    for(const file of input.files) {
      const path=join(inputs,key,file.path);
      assert.equal(digest(await readFile(path)),file.sha256,file.path);
      uploads.push(path);
    }
    let before;
    if (process.env.SOFTCERT_REUSE_CASES) {
      const id = archivedCases[key];
      await page.goto(origin+'/?case='+id);
      const prior = await page.request.get(origin+'/api/cases/'+id);
      before = await prior.json();
      assert.equal(before.request,input.request);
      for (const upload of input.files) {
        assert.ok([...before.entries,...before.containers].some(file=>file.hash===upload.sha256),upload.path);
      }
      const stale = await page.request.get(origin+'/api/cases/'+id+'/download/'+before.audit.id);
      assert.equal(stale.status(),409);
      await collect(page,'/preflight',()=>page.getByRole('button',{name:'重试预检',exact:true}).click());
    } else {
      await page.goto(origin);
      await page.locator('#request').fill(input.request);
      await page.locator('#files').setInputFiles(uploads);
      await collect(page,'/api/cases',()=>page.getByRole('button',{name:'开始预检',exact:true}).click());
    }
    await page.screenshot({path:join(target,'工作台-原件预检.png'),fullPage:true});
    await page.locator('#software-name').fill(name);
    await page.locator('#version').fill(input.version);
    const confirmed=await collect(page,'/target',()=>page.getByRole('button',{name:'确认版本',exact:true}).click());
    assert.equal(confirmed.target.version,input.version);
    const result=await collect(page,'/process',()=>page.getByRole('button',{name:'自动修订并复验',exact:true}).click());
    await page.getByText('终件复验',{exact:true}).waitFor();
    const audit=result.audit;
    const bundle=await save(page,'下载内部审阅包',join(target,'工作台-实际下载.zip'));
    const archive=await JSZip.loadAsync(bundle);
    const receipt=JSON.parse(await archive.file('审核回执.json').async('string'));
    assert.equal(receipt.id,audit.id);
    const selected=audit.allowed.filter(item=>['source-pdf','filing-manual','filing-form-word','filing-manual-word'].includes(item.kind)
      || /申请表底稿\.md$|申请人补件清单\.md$|源码行号映射\.json$|说明书正文\.md$/.test(item.path));
    await page.getByText(/^逐件下载/).click();
    const downloaded=[];
    for(const item of selected) {
      const file=basename(item.path);
      const fromLink=await save(page,item.path,join(files,file));
      assert.equal(digest(fromLink),item.hash,item.path);
      assert.equal(digest(await archive.file('经审核材料/'+item.path).async('nodebuffer')),item.hash,item.path);
      downloaded.push({file,path:item.path,sha256:item.hash,kind:item.kind});
    }
    for(const label of ['七项验收','R5 同版实操核对']) await page.getByText(label,{exact:true}).click();
    const card=page.getByRole('heading',{name:'终件复验',exact:true}).locator('..');
    await card.screenshot({path:join(target,'工作台-终件复验与下载.png'),timeout:120000});
    const submission=page.getByRole('heading',{name:'提交准备度核对',exact:true});
    if(await submission.count()) {
      await submission.locator('..').screenshot({path:join(target,'工作台-待补事项.png'),timeout:120000});
    }
    const record={key,request:input.request,inputFiles:input.files,confirmed:confirmed.target,
      caseId:result.id,revision:result.revision,method:result.method,policy:result.policy,
      ...(before && {priorAudit:before.audit.id,priorPolicy:before.policy,priorDownloadStatus:409}),
      audit,downloaded,archiveSha256:digest(bundle),errors};
    await writeFile(join(target,'工作台回执.json'),JSON.stringify(record,null,2)+'\n');
    const expected=volumes.map(volume=>'交存源码－'+volume+'.pdf').sort();
    const actual=downloaded.filter(item=>item.kind==='source-pdf').map(item=>item.file).sort();
    const row={key, expected,actual,figureCount, findings:audit.issues, layouts:audit.layout.map(item=>({path:item.path, pages:item.pages?.length, lines:Math.min(...item.pages.map(page=>page.lines))})),deliverables:audit.work.deliverables.map(item=>[item.key,item.status])};
    results.push(row);
    console.log(JSON.stringify(row));
    const map=JSON.parse(await archive.file('源码行号映射.json').async('string'));
    const scope=map.runtime_resource_scope;
    assert.ok(scope && scope.archiveSha256 === audit.runtimeEvidence.records[0].archiveSha256);
    if(key==='亲戚关系计算器') {
      const [entry]=map.files;
      assert.match(entry.path,/\/index\.html$/u);
      assert.equal(entry.sha256,scope.files.find(file=>file.url==='/index.html').sha256);
      assert.ok(map.line_mapping.some(line=>line.file===entry.path && line.source_line >= 580 && line.source_line <= 761));
    } else {
      assert.equal(scope.files.length,8);
      assert.deepEqual(scope.files.filter(file=>file.decision==='纳入').map(file=>file.path).sort(),
        ['src/css/content-theme/light.css','src/js/i18n/zh_CN.js']);
      for(const file of scope.supplements) assert.ok(map.files.some(item=>item.path===file.path && item.sha256===file.hash));
    }
    assert.ok(audit.replay.length && audit.draftingFacts.launch.some(line=>line.includes('http://127.0.0.1:8000/')));
    for(const file of audit.replay) assert.equal(digest(await archive.file(file.path).async('nodebuffer')),file.hash);
    assert.deepEqual(audit.work.missingDeliverables,[]);
    assert.equal(audit.work.deliverables.filter(item=>item.status==='经审核').length,3);
    assert.equal(audit.runtimeEvidence.matched,figureCount);
    assert.ok(downloaded.some(item=>item.kind==='filing-manual'));
    assert.equal(audit.filingReady,false);
    assert.deepEqual(errors,[]);
    await page.close();
  }
  assert.deepEqual(results.flatMap(row=>row.actual),results.flatMap(row=>row.expected));
} finally {
  await browser.close();
  if(server.exitCode===null) {const exit=once(server,'exit');server.kill();await exit;}
  if (!retainedData) await rm(data,{recursive:true,force:true});
}
