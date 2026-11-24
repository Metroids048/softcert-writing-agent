import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, chrome, root, JSZip} from '../runtime.mjs';
import {digest} from '../files.mjs';

const origin = process.env.SOFTCERT_ORIGIN || 'http://127.0.0.1:8793';
const evidence = process.argv[2];
const baseline = process.argv.includes('--baseline');
const source = join(root,'运行证据/v0.3.3-通用生成复验/原始输入/rich-cli-v1.8.1-source.zip');
const runInput = join(root,'运行证据/v0.3.5-同版实操复验/Rich CLI－实操证据输入.zip');
const recordPath = '实操证据/rich.softcert-run.json';
const browser = await chromium.launch({executablePath:chrome,headless:true});
const page = await browser.newPage({viewport:{width:1380,height:980}});
const errors = [];
page.on('pageerror',error=>errors.push(error.message));
await mkdir(evidence,{recursive:true});

async function submit(name,path) {
  const [response] = await Promise.all([
    page.waitForResponse(result=>result.request().method()==='POST' &&
      result.url().split('?')[0].endsWith(path),{timeout:120000}),
    page.getByRole('button',{name,exact:true}).click(),
  ]);
  assert.equal(response.status(),200,await response.text());
  await page.locator('#notice').waitFor({state:'hidden'});
  return response.json();
}

async function prepare() {
  await page.getByLabel('本次软件版本').fill('V1.8.1');
  await submit('确认版本','/target');
  return submit('自动修订并复验','/process');
}

async function download(name,link) {
  const [result] = await Promise.all([page.waitForEvent('download'),link.click()]);
  assert.equal(await result.failure(),null);
  await result.saveAs(join(evidence,name));
  return readFile(join(evidence,name));
}

try {
  await page.goto(origin);
  await page.locator('#request').fill('这是 Rich CLI 的发布源码和 README。请准备申请表底稿和中文说明书，核对同版实操记录和申报缺项。');
  await page.locator('#files').setInputFiles([source,runInput]);
  await submit('开始预检','/api/cases');
  const reviewed = await prepare();
  const r5 = audit=>audit.rows.find(row=>row.id==='R5');
  const initial = {url:page.url(),version:reviewed.method,id:reviewed.audit.id,r5:r5(reviewed.audit),
    runtime:reviewed.audit.runtimeEvidence, inputs:reviewed.entries.map(({path,hash})=>({path,hash})),
    quality:reviewed.audit.quality, readiness:reviewed.audit.formal,rows:reviewed.audit.rows};
  if (baseline) {
    await writeFile(join(evidence,'v0.3.4-同输入回执.json'),JSON.stringify(initial,null,2)+'\n');
    assert.equal(reviewed.method,'workbench/0.3.4');
    assert.equal(initial.runtime,undefined);
    console.log(JSON.stringify(initial));
  } else {
    const audit = reviewed.audit;
    assert.equal(reviewed.method,'workbench/0.3.5');
    assert.equal(audit.valid,true);
    assert.equal(audit.runtimeEvidence.matched,2,JSON.stringify(initial));
    assert.equal(audit.runtimeEvidence.records[0].reportedVersion,'V1.8.0');
    assert.equal(audit.runtimeEvidence.records[0].status,'版本显示待核');
    assert.equal(audit.runtimeEvidence.records[0].expectedVersion,'V1.8.1');
    assert.equal(audit.rows.find(row=>row.id==='R2').formal,0);
    assert.equal(r5(audit).formal,0);
    assert.equal(r5(audit).status,'待补');
    assert.equal(audit.filingReady,false);
    const ui = page.locator('details').filter({has:page.getByText('R5 同版实操核对',{exact:true})});
    await ui.locator('summary').click();
    await ui.getByText('rich cats.json',{exact:true}).waitFor();
    await ui.getByText('rich README.md -o readme.html',{exact:true}).waitFor();
    await ui.getByText(/V1\.8\.0/).first().waitFor();
    await page.screenshot({path:join(evidence,'网页实操核对.png'),fullPage:true});
    const bundleLink = page.getByRole('link',{name:'下载内部审阅包'});
    const old = new URL(await bundleLink.getAttribute('href'),origin);
    const bytes = await download('Rich CLI－内部审阅包.zip',bundleLink);
    const zip = await JSZip.loadAsync(bytes);
    const receipt = JSON.parse(await zip.file('审核回执.json').async('string'));
    assert.deepEqual(receipt.runtimeEvidence,audit.runtimeEvidence);
    const report = await zip.file('审核报告.md').async('string');
    assert.match(report,/rich cats\.json/);
    assert.match(report,/V1\.8\.0/);
    const before = JSON.parse(await readFile(join(evidence,'v0.3.4-同输入回执.json')));
    assert.deepEqual(initial.inputs,before.inputs);
    for (const file of audit.disposition.filter(item=>item.path.startsWith('实操证据/'))) {
      assert.equal(digest(await zip.file(file.bundlePath).async('nodebuffer')),file.hash);
    }
    const trackedManuals = new Map(audit.runtimeEvidence.records[0].steps.flatMap(step=>step.locations)
      .map(location=>[location.path,location.sha256]));
    assert.equal(trackedManuals.size,2);
    await page.getByText(/^逐件下载/).click();
    for (const [path,hash] of trackedManuals) {
      const name = 'Rich CLI－'+path.split('/').at(-1);
      const single = await download(name,page.getByRole('link',{name:path,exact:true}));
      assert.equal(digest(single),hash);
      assert.equal(digest(await zip.file('经审核材料/'+path).async('nodebuffer')),hash);
    }

    const retryEvidence = await JSZip.loadAsync(await readFile(runInput));
    const record = JSON.parse(await retryEvidence.file(recordPath).async('string'));
    const wrongSnapshot = {...record,archiveSha256:'0'.repeat(64)};
    retryEvidence.file('实操证据/wrong-source.softcert-run.json',JSON.stringify(wrongSnapshot));
    const wrongStep = {...record.steps[0],action:'rich missing.json'};
    const missingFile = {...record.steps[1],proof:{...record.steps[1].proof,sha256:'0'.repeat(64)}};
    retryEvidence.file(recordPath,JSON.stringify({...record,steps:[wrongStep,missingFile]}));
    await page.locator('#files').setInputFiles({
      name:'实操证据补传.zip',mimeType:'application/zip',buffer:await retryEvidence.generateAsync({type:'nodebuffer'}),
    });
    await submit('保存材料并预检','/intake');
    assert.equal((await page.request.get(old.href)).status(),409);
    const rejected = await prepare();
    assert.equal(rejected.audit.runtimeEvidence.matched,0);
    const records = rejected.audit.runtimeEvidence.records;
    assert.ok(records.some(record=>record.status==='源码不符'));
    const rejectedSteps = records.find(item=>item.path===recordPath).steps;
    assert.ok(rejectedSteps.some(step=>step.status==='终件找不到动作'));
    assert.ok(rejectedSteps.some(step=>step.status==='运行产物不符'));
    assert.ok(rejected.audit.actions.some(item=>item.id==='R5'));
    assert.deepEqual(errors,[]);
    await writeFile(join(evidence,'浏览器回执.json'),JSON.stringify({
      initial, archiveSha256:digest(bytes), retained:receipt.disposition.filter(item=>item.path.startsWith('实操证据/')),
      allRows:audit.rows, allowed:audit.allowed, rejected:rejected.audit.runtimeEvidence, replacedDownloadStatus:409,
    },null,2)+'\n');
    console.log(JSON.stringify({initial,negative:records.map(record=>record.status)}));
  }
} finally { await browser.close(); }
