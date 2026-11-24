import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [project,output,version,mode] = process.argv.slice(2);
assert.ok(project && output && version,'Usage: node self-review-browser.mjs <project> <evidence> <label> [--candidate]');
const candidate = mode === '--candidate';
const app = resolve(project,'app');
const {chromium,chrome,JSZip} = await import(pathToFileURL(join(app,'runtime.mjs')));
const {digest} = await import(pathToFileURL(join(app,'files.mjs')));
const database = await mkdtemp(join(tmpdir(),'softcert-browser-'));
const server = spawn(join(app,'start.sh'),{cwd:project,env:{...process.env,SOFTCERT_PORT:'0',SOFTCERT_DATA:database}});
let logs = '';
server.stderr.on('data',chunk=>{logs += chunk;});
const origin = await new Promise((done,reject)=>{
  server.stdout.on('data',chunk=>{
    const url = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
    if (url) done(url);
  });
  server.once('error',reject);
  server.once('exit',code=>reject(new Error('server exit '+code+' '+logs)));
});
const browser = await chromium.launch({executablePath:chrome,headless:true});

async function runCase(name) {
  const directory = join(output,name);
  const originals = join(directory,'原始输入');
  const out = join(directory,version);
  await mkdir(out,{recursive:true});
  const frozen = JSON.parse(await readFile(join(directory,'冻结输入.json')));
  const files = await readdir(originals);
  assert.deepEqual(Object.keys(frozen.inputs).sort(),files.sort());
  for (const file of files) assert.equal(digest(await readFile(join(originals,file))),frozen.inputs[file]);
  const page = await browser.newPage({viewport:{width:1360,height:940}});
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));

  async function submit(name,path) {
    const [response] = await Promise.all([
      page.waitForResponse(result=>result.request().method()==='POST' &&
        result.url().split('?')[0].endsWith(path),{timeout:180000}),
      page.getByRole('button',{name,exact:true}).click(),
    ]);
    assert.equal(response.status(),200,await response.text());
    await page.locator('#notice').waitFor({state:'hidden'});
    return response.json();
  }
  async function download(name,link) {
    const [event] = await Promise.all([page.waitForEvent('download'),link.click()]);
    assert.equal(await event.failure(),null);
    await event.saveAs(join(out,name));
    return readFile(join(out,name));
  }
  try {
    await page.goto(origin);
    const request = '请核对自备使用说明书和源程序，逐项核同版本功能、操作和结果。';
    await page.locator('#request').fill(request);
    await page.locator('#files').setInputFiles(files.map(file=>join(originals,file)));
    await submit('开始预检','/api/cases');
    await page.getByLabel('本次软件版本').fill(frozen.version);
    await submit('确认版本','/target');
    const result = await submit('自动修订并复验','/process');
    assert.equal(result.stage,'audited',JSON.stringify(result.lastError));
    assert.equal(result.audit.valid,true);
    const audit = result.audit;
    if (candidate) {
      assert.equal(audit.actions.some(item=>item.id === 'R2' && item.title === '补发布证据'),false);
      assert.equal(audit.actions.some(item=>item.id === 'R5' && /同版依据|核对实操与待补范围/u.test(item.title)),false);
      assert.ok(audit.quality >= 85);
      assert.deepEqual(audit.issues,[]);
      assert.deepEqual(audit.drafts,[]);
      assert.equal(audit.verifiedSources[0].sha256,frozen.inputs['自备源程序.pdf']);
      assert.equal(audit.runtimeEvidence.matched,frozen.softwareClaims.length);
      assert.deepEqual(audit.verifiedManuals[0].features.map(item=>[item.name,item.status]),
        frozen.softwareClaims.map(item=>[item.name,'同版结果已对照']));
      assert.equal(audit.submission.reviewed,0);
      assert.equal(audit.filingReady,false);
    }
    await writeFile(join(out,'网页回执.json'),JSON.stringify({url:page.url(),request,method:result.method,
      inputStamp:result.inputStamp,revision:result.revision,preflight:result.preflight,audit},null,2));
    const bundleLink = page.getByRole('link',{name:'下载内部审阅包'});
    const prior = [await bundleLink.getAttribute('href')];
    const zip = await download('网页下载－内部审阅包.zip',bundleLink);
    const bundle = await JSZip.loadAsync(zip);
    const embedded = JSON.parse(await bundle.file('审核回执.json').async('string'));
    assert.equal(embedded.id,audit.id);
    const inventory = JSON.parse(await bundle.file('输入清单.json').async('string'));
    for (const [path,hash] of Object.entries(frozen.inputs)) {
      assert.ok([...inventory.entries,...inventory.containers].some(file=>file.path===path && file.hash===hash));
    }
    for (const entry of audit.disposition) {
      assert.equal(digest(await bundle.file(entry.bundlePath).async('nodebuffer')),entry.hash,entry.bundlePath);
    }
    const readiness = await download('网页下载－提交准备度核对.md',page.getByRole('link',{name:'下载提交准备度核对'}));
    assert.deepEqual(readiness,await bundle.file('提交准备度核对.md').async('nodebuffer'));
    for (const item of audit.allowed) {
      assert.equal(digest(await bundle.file('经审核材料/'+item.path).async('nodebuffer')),item.hash);
    }
    const selections = {};
    await page.getByText(/^逐件下载/).click();
    for (const file of ['自备使用说明书.pdf','自备源程序.pdf']) {
      const approved = audit.allowed.find(item=>item.path === file);
      if (!approved) continue;
      const link = page.getByRole('link',{name:file,exact:true});
      prior.push(await link.getAttribute('href'));
      const single = await download('网页下载－'+file,link);
      assert.equal(digest(single),approved.hash);
      assert.equal(digest(single),frozen.inputs[file]);
      selections[file] = digest(single);
    }
    await page.screenshot({path:join(out,'网页终件复验.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    await writeFile(join(out,'下载校验.json'),JSON.stringify({zip:digest(zip),selections,caseId:audit.caseId,
      receipt:audit.id,allowed:audit.allowed.map(file=>file.path),blocked:audit.blocked,drafts:audit.drafts,
      submission:audit.submission.items.map(({id,title,status})=>({id,title,status}))},null,2));
    if (candidate && name === 'tomli') {
      const negative = [];
      async function replace(payload,stale) {
        await page.locator('#files').setInputFiles(payload);
        await submit('保存材料并预检','/intake');
        const expired = await Promise.all(stale.map(path=>page.request.get(new URL(path,origin).href)
          .then(response=>response.status())));
        assert.deepEqual(expired,stale.map(()=>409));
        await page.getByLabel('本次软件版本').fill(frozen.version);
        await submit('确认版本','/target');
        const revised = await submit('自动修订并复验','/process');
        assert.equal(revised.audit.valid,true);
        return {revised:revised.audit,expired};
      }
      const runArchive = join(originals,'同版操作证据.zip');
      const suppliedRun = await JSZip.loadAsync(await readFile(runArchive));
      const recordPath = '实操证据/操作.softcert-run.json';
      const record = JSON.parse(await suppliedRun.file(recordPath).async('string'));
      const proof = record.steps[1].proof;
      const falseResult = Buffer.from('not '+record.steps[1].expected+'\n');
      suppliedRun.file(proof.path,falseResult);
      proof.sha256 = digest(falseResult);
      suppliedRun.file(recordPath,JSON.stringify(record));
      const wrongRuntime = await replace({name:'同版操作证据.zip',mimeType:'application/zip',
        buffer:await suppliedRun.generateAsync({type:'nodebuffer'})},prior);
      assert.ok(wrongRuntime.revised.issues.some(item=>item.id==='R5' && item.path==='自备使用说明书.pdf'));
      assert.equal(wrongRuntime.revised.selfReview.reviews[0].features[1].steps[0].conflict,true);
      assert.ok(!wrongRuntime.revised.allowed.some(file=>file.path==='自备使用说明书.pdf'));
      negative.push({change:'实际输出由 True 改为 not True，更新了产物指纹',...wrongRuntime});
      const staleRuntime = await bundleLink.getAttribute('href');
      const wrongSource = await replace([{name:'同版操作证据.zip',mimeType:'application/zip',buffer:await readFile(runArchive)},
        {name:'自备源程序.pdf',mimeType:'application/pdf',
        buffer:await readFile(join(output,'python-slugify','原始输入','自备源程序.pdf'))}],[staleRuntime]);
      assert.ok(wrongSource.revised.issues.some(item=>item.id==='R4' && item.path==='自备源程序.pdf'));
      assert.ok(!wrongSource.revised.allowed.some(file=>file.path==='自备源程序.pdf'));
      assert.equal(wrongSource.revised.verifiedSources.length,0);
      negative.push({change:'源程序 PDF 换成另一软件的实际源码册',...wrongSource});
      const restored = await replace(join(originals,'自备源程序.pdf'),[await bundleLink.getAttribute('href')]);
      assert.deepEqual(restored.revised.issues,[]);
      assert.equal(restored.revised.verifiedManuals[0].status,'逐项结果已对照');
      assert.equal(restored.revised.verifiedSources[0].sha256,frozen.inputs['自备源程序.pdf']);
      const recoveredZip = await download('网页恢复后下载－内部审阅包.zip',bundleLink);
      const recovered = await JSZip.loadAsync(recoveredZip);
      assert.equal(JSON.parse(await recovered.file('审核回执.json').async('string')).id,restored.revised.id);
      assert.deepEqual(await recovered.file('经审核材料/自备使用说明书.pdf').async('nodebuffer'),
        await bundle.file('经审核材料/自备使用说明书.pdf').async('nodebuffer'));
      await writeFile(join(out,'换件与恢复回执.json'),JSON.stringify({negative,restored,
        recoveredZip:digest(recoveredZip)},null,2)+'\n');
    }
    console.log(JSON.stringify({name,method:result.method,quality:audit.quality,readiness:audit.formal,
      r:audit.rows.map(row=>[row.id,row.quality,row.evidence]),allowed:audit.allowed.map(file=>file.path),
      blocked:audit.issues,drafts:audit.drafts,self:audit.selfReview?.reviews.map(row=>[row.status,row.features.map(f=>f.status)]),
      runtime:audit.runtimeEvidence.matched,submission:audit.submission.reviewed}));
  } finally { await page.close(); }
}
try {
  const results = await Promise.allSettled(['tomli','python-slugify'].map(runCase));
  for (const result of results) if (result.status==='rejected') {
    console.error(result.reason);
    process.exitCode=1;
  }
} finally {
  await browser.close();
  const exited=once(server,'exit');
  server.kill();
  await exited;
  if (logs) console.error(logs.slice(-8000));
  await rm(database,{recursive:true,force:true});
}
