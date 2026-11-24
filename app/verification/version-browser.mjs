import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, chrome, root, JSZip} from '../runtime.mjs';
import {digest} from '../files.mjs';

const origin = process.env.SOFTCERT_ORIGIN || 'http://127.0.0.1:8793';
const output = process.argv[2];
const baseline = process.argv.includes('--baseline');
const previous = join(root,'运行证据/v0.3.5-同版实操复验');
const source = join(root,'运行证据/v0.3.3-通用生成复验/原始输入/rich-cli-v1.8.1-source.zip');
const runtimeInput = join(previous,'Rich CLI－实操证据输入.zip');
const request = '这是 Rich CLI 的发布源码和 README。请准备申请表底稿和中文说明书，核对同版实操记录和申报缺项。';
const browser = await chromium.launch({executablePath:chrome,headless:true});
const page = await browser.newPage({viewport:{width:1380,height:940}});
const errors = [];
page.on('pageerror',error=>errors.push(error.message));
await mkdir(output,{recursive:true});

async function submit(button, route) {
  const [response] = await Promise.all([
    page.waitForResponse(item=>item.request().method()==='POST' && item.url().split('?')[0].endsWith(route),{timeout:120000}),
    page.getByRole('button',{name:button,exact:true}).click(),
  ]);
  assert.equal(response.status(),200,await response.text());
  await page.locator('#notice').waitFor({state:'hidden'});
  return response.json();
}

async function start(files, instructions=request) {
  await page.goto(origin);
  await page.locator('#request').fill(instructions);
  await page.locator('#files').setInputFiles(files);
  return submit('开始预检','/api/cases');
}

async function confirm(version) {
  await page.getByLabel('本次软件版本').fill(version);
  return submit('确认版本','/target');
}

async function save(name, link=page.getByRole('link',{name:'下载内部审阅包'})) {
  const [download] = await Promise.all([page.waitForEvent('download'),link.click()]);
  assert.equal(await download.failure(),null);
  const path = join(output,name);
  await download.saveAs(path);
  return readFile(path);
}

const r2 = report => report.rows.find(row=>row.id === 'R2');
const hashes = state => state.entries.map(({path,hash})=>({path,hash}));
const json = async (zip,name) => JSON.parse(await zip.file(name).async('string'));
const payload = (name,buffer) => ({name,mimeType:'application/zip',buffer});
const zipBytes = zip => zip.generateAsync({type:'nodebuffer'});

async function genericVersionCheck() {
  const sourceZip = new JSZip();
  const originalCode = 'export function indexParcels(rows) { return rows.sort(); }\n';
  sourceZip.file('package.json',JSON.stringify({name:'parcel-index',version:'2.3.0',
    description:'按运单号排序并生成包裹索引',engines:{node:'>=20'}},null,2));
  sourceZip.file('src/index.js',originalCode);
  const sourceBytes = await zipBytes(sourceZip);
  const originalSource = payload('包裹索引－发布源码.zip',sourceBytes);
  const form = '软件全称：parcel-index\n版本号：V2.3.0\n编程语言：JavaScript\n主要功能：按运单号整理包裹。\n';
  const manual = [
    '# parcel-index V2.3.0 用户手册','','软件全称：parcel-index','| 软件版本 | V2.2.0 |','',
    '## 软件概述','本工具将输入文件中的运单按编号排序并写出索引，方便仓库人员核对包裹。',
    '## 运行环境','使用 Node.js 20 或更新版本。先将仓库台账存为 UTF-8 文本，每行记录一条运单。',
    '## 操作步骤','复制试用清单至当前工作目录。执行以下命令处理文件。','`node src/index.js parcels.txt`',
    '检查生成的文件是否仅包含当前批次运单，并对照原台账逐项核验。','',
  ].join('\n');
  const documentsZip = new JSZip();
  documentsZip.file('申请表.md',form);
  documentsZip.file('用户手册.md',manual);
  const proof = Buffer.from('2.3.0\n');
  const stdout = Buffer.from('已生成索引：PKG-1001\n');
  const runtimeZip = new JSZip();
  runtimeZip.file('实操证据/version.txt',proof);
  runtimeZip.file('实操证据/sort-output.txt',stdout);
  runtimeZip.file('实操证据/parcel.softcert-run.json',JSON.stringify({schema:'softcert-runtime/v1',
    softwareName:'parcel-index',version:'V2.3.0',archiveSha256:digest(sourceBytes),
    versionProbe:{path:'实操证据/version.txt',sha256:digest(proof)},steps:[{
      action:'node src/index.js parcels.txt',role:'仓库人员',precondition:'准备示例台账 parcels.txt',
      expected:'终端显示包裹索引',exitCode:0,proof:{path:'实操证据/sort-output.txt',sha256:digest(stdout),contains:['PKG-1001']},
    }]}));
  const uploaded = await start([originalSource,payload('包裹索引－稿件.zip',await zipBytes(documentsZip)),
    payload('包裹索引－实操结构测试.zip',await zipBytes(runtimeZip))],
  '我们要准备软著，核对版本，按提供的申请表和用户手册生成申请表底稿和说明书。');
  assert.equal(uploaded.preflight.versionCheck.status,'conflict');
  assert.deepEqual(uploaded.preflight.versionCheck.groups.manuscript.filter(item=>item.path==='用户手册.md')
    .map(item=>item.version),['V2.3.0','V2.2.0']);
  assert.equal(uploaded.preflight.versionCheck.questions.find(item=>item.conflict).title,'核对稿件里的版本');
  assert.equal((await confirm('V2.3.0')).preflight.versionCheck.status,'conflict');
  const blocked = await submit('生成版本待核包','/process');
  assert.deepEqual(blocked.audit.allowed,[]);
  assert.equal(blocked.candidate.changes.length,0);
  const link = page.getByRole('link',{name:'下载内部审阅包'});
  const blockedUrl = new URL(await link.getAttribute('href'),origin);
  const supplement = new JSZip();
  supplement.file('用户手册.md',manual.replace('V2.2.0','V2.3.0'));
  await page.locator('#files').setInputFiles([payload('同版稿件－补件.zip',await zipBytes(supplement))]);
  const corrected = await submit('保存材料并预检','/intake');
  assert.equal(corrected.preflight.versionCheck.status,'matched');
  assert.equal((await page.request.get(blockedUrl.href)).status(),409);
  const wrongTarget = await confirm('V2.9.0');
  assert.ok(wrongTarget.preflight.versionCheck.questions.some(item=>item.title==='核对拟申报版本' && item.conflict));
  const confirmed = await confirm('V2.3.0');
  assert.equal(confirmed.preflight.versionCheck.status,'matched');
  const reviewed = await submit('自动修订并复验','/process');
  assert.equal(reviewed.audit.issues.filter(item=>item.id==='R2').length,0);
  assert.equal(reviewed.audit.runtimeEvidence.records[0].reportedVersion,'V2.3.0');
  assert.equal(reviewed.audit.runtimeEvidence.matched,1);
  assert.ok(reviewed.audit.allowed.some(item=>item.kind==='filing-form'));
  const reviewedUrl = new URL(await link.getAttribute('href'),origin);
  const [download] = await Promise.all([page.waitForEvent('download'),link.click()]);
  assert.equal(await download.failure(),null);
  const archive = await JSZip.loadAsync(await readFile(await download.path()));
  const reviewedReceipt = await json(archive,'审核回执.json');
  assert.equal(reviewedReceipt.id,reviewed.audit.id);
  assert.match(await archive.file('经审核材料/申报准备/申请表底稿.md').async('string'),/版本号：V2\.3\.0/u);
  const newerSource = new JSZip();
  newerSource.file('src/index.js',originalCode.replace('rows.sort()','rows.slice().sort()'));
  await page.locator('#files').setInputFiles([payload('局部替换源码.zip',await zipBytes(newerSource))]);
  const stale = await submit('保存材料并预检','/intake');
  assert.equal(stale.preflight.versionCheck.status,'pending');
  assert.equal(stale.preflight.versionCheck.probes[0].bound,false);
  assert.equal((await page.request.get(reviewedUrl.href)).status(),409);
  await writeFile(join(output,'非Rich通用网页回归.json'),JSON.stringify({
    caseId:reviewed.id,sourceManifest:'package.json',manuscriptConflict:uploaded.preflight.versionCheck,
    blockedReceipt:blocked.audit.id,corrected:confirmed.preflight.versionCheck,correctedR2:r2(reviewed.audit),
    reviewedReceipt:reviewedReceipt.id,sourceChanged:stale.preflight.versionCheck,staleDownloadStatuses:[409,409],
    note:'版本和实操结构造数，仅作回归。未执行样本命令。',
  },null,2)+'\n');
  console.log('非 Rich 通用网页回归通过：稿件冲突、确认版本、换稿、换源码及旧回执失效。');
}

try {
  const uploaded = await start([source,runtimeInput]);
  const target = await confirm('V1.8.1');
  assert.equal(uploaded.candidate,null);
  assert.equal(target.candidate,null);
  if (baseline) {
    assert.equal(uploaded.method,'workbench/0.3.5');
    assert.equal(uploaded.preflight.versionCheck,undefined);
    assert.ok(!uploaded.preflight.report.versionEvidence.some(hit=>hit.path.startsWith('实操证据/')));
    const audited = await submit('自动修订并复验','/process');
    assert.equal(audited.audit.runtimeEvidence.records[0].reportedVersion,'V1.8.0');
    assert.ok(audited.audit.allowed.some(file=>file.kind==='filing-manual'));
    const bytes = await save('Rich CLI－v0.3.5网页基线.zip');
    const archive = await JSZip.loadAsync(bytes);
    assert.equal((await json(archive,'审核回执.json')).id,audited.audit.id);
    const data = {url:page.url(),inputs:hashes(uploaded),preflight:r2(target.preflight.report),
      receiptId:audited.audit.id,artifactSha256:digest(bytes),
      allowed:audited.audit.allowed.map(file=>file.path),final:r2(audited.audit)};
    await writeFile(join(output,'v0.3.5-同输入网页回执.json'),JSON.stringify(data,null,2)+'\n');
    console.log('已复现旧版先生成稿件、后发现运行版本冲突。');
  } else {
    const baselineReceipt = process.env.SOFTCERT_VERSION_BASELINE ?? join(output,'v0.3.5-同输入网页回执.json');
    const before = JSON.parse(await readFile(baselineReceipt));
    assert.deepEqual(hashes(uploaded),before.inputs);
    assert.equal(uploaded.preflight.versionCheck.status,'conflict');
    assert.equal(target.preflight.versionCheck.status,'conflict');
    const versionCard = page.getByRole('region',{name:'R2 起草前版本核对'});
    await versionCard.getByText(/pyproject\.toml/).first().waitFor();
    await versionCard.getByText(/version\.txt/).first().waitFor();
    await versionCard.getByText(/README\.md/).first().waitFor();
    await versionCard.screenshot({path:join(output,'Rich CLI－起草前版本核对.png')});
    const audited = await submit('生成版本待核包','/process');
    assert.equal(audited.method,process.env.SOFTCERT_EXPECT_METHOD ?? 'workbench/0.3.6');
    assert.equal(audited.candidate.changes.length,0);
    assert.equal(audited.audit.valid,true);
    assert.equal(audited.audit.versionCheck.status,'conflict');
    assert.equal(r2(audited.audit).formal,0);
    assert.deepEqual(audited.audit.allowed,[]);
    assert.deepEqual(audited.audit.drafts,[]);
    assert.equal(audited.audit.runtimeEvidence.records[0].reportedVersion,'V1.8.0');
    const bytes = await save('Rich CLI－版本待核包.zip');
    const archive = await JSZip.loadAsync(bytes);
    const receipt = await json(archive,'审核回执.json');
    assert.equal(receipt.id,audited.audit.id);
    assert.deepEqual(receipt.versionCheck,audited.audit.versionCheck);
    const report = await archive.file('版本核对.md').async('string');
    assert.match(report,/V1\.8\.1[\s\S]*pyproject\.toml/);
    assert.match(report,/V1\.8\.0[\s\S]*version\.txt/);
    assert.match(report,/README\.md/);
    assert.equal(receipt.disposition.length,before.inputs.length);
    for (const file of receipt.disposition) {
      assert.equal(digest(await archive.file(file.bundlePath).async('nodebuffer')),file.hash);
    }
    await writeFile(join(output,'浏览器回执.json'),JSON.stringify({url:page.url(),
      method:audited.method,inputs:hashes(uploaded),preflight:uploaded.preflight.versionCheck,
      confirmed:target.preflight.versionCheck,final:r2(audited.audit),receiptId:receipt.id,
      artifactSha256:digest(bytes),allowed:receipt.allowed},null,2)+'\n');
    console.log('同输入网页取件及 R2 冲突核对通过。');
    if (!process.argv.includes('--rich-only')) await genericVersionCheck();
    assert.deepEqual(errors,[]);
  }
} finally { await browser.close(); }
