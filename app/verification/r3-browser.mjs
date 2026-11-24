import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, chrome, root, JSZip} from '../runtime.mjs';
import {digest} from '../files.mjs';

const origin = process.env.SOFTCERT_ORIGIN || 'http://127.0.0.1:8793';
const output = process.argv[2];
const baseline = process.argv.includes('--baseline');
const richSource = join(root,'运行证据/v0.3.3-通用生成复验/原始输入/rich-cli-v1.8.1-source.zip');
const richRuntime = join(root,'运行证据/v0.3.5-同版实操复验/Rich CLI－实操证据输入.zip');
const request = '这是 Rich CLI 的发布源码和 README。请准备申请表底稿和中文说明书，核对同版实操记录和申报缺项。';
const browser = await chromium.launch({executablePath:chrome,headless:true});
const page = await browser.newPage({viewport:{width:1380,height:950}});
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

async function start(files, instructions) {
  await page.goto(origin);
  await page.locator('#request').fill(instructions);
  await page.locator('#files').setInputFiles(files);
  return submit('开始预检','/api/cases');
}

async function confirm(version) {
  await page.getByLabel('本次软件版本').fill(version);
  return submit('确认版本','/target');
}

const bundle = () => page.getByRole('link',{name:'下载内部审阅包'});
const saveJSON = (name,value) => writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const r3 = report => report.rows.find(row=>row.id==='R3');
const current = (check,id) => check.items.find(item=>item.id===id);

async function download(audit,name) {
  const [received] = await Promise.all([page.waitForEvent('download'),bundle().click()]);
  assert.equal(await received.failure(),null);
  const path = join(output,name);
  await received.saveAs(path);
  const bytes = await readFile(path);
  const zip = await JSZip.loadAsync(bytes);
  const receipt = JSON.parse(await zip.file('审核回执.json').async('string'));
  assert.equal(receipt.id,audit.id);
  for (const entry of receipt.disposition) assert.equal(digest(await zip.file(entry.bundlePath).async('nodebuffer')),entry.hash);
  return {zip,receipt,sha256:digest(bytes)};
}

async function uploadZip(name, files, create=false) {
  const zip = new JSZip();
  for (const [path,text] of Object.entries(files)) zip.file(path,text);
  const file = {name,mimeType:'application/zip',buffer:await zip.generateAsync({type:'nodebuffer'})};
  if (create) return start([file],'请按这次的项目和原件准备申请表底稿，核对申请人、权属与签章。');
  await page.locator('#files').setInputFiles([file]);
  return submit('保存材料并预检','/intake');
}

async function genericCase() {
  const name = '桐叶索引实验室';
  const form = '# 计算机软件著作权登记申请表\n软件全称：folio-sort\n版本号：V2.3.0\n| 申请人 | '+name+
    ' |\n首次发表地点：\n著作权人：'+name+'\n权利取得方式：原始取得\n权利范围：全部权利\n'+
    '\n| 字段 | 填写提示 | 实际值 |\n| --- | --- | --- |\n| 开发方式 | 请按实际选项填写 | 委托开发 |\n'+
    '\n| 事项 | 为什么必须你定 | 建议 |\n| --- | --- | --- |\n| 开发方式 | 合作开发 | 此行仅用于说明 |\n';
  const manual = '# folio-sort V2.3.0 用户手册\n\n## 软件用途\n本工具根据输入的清册生成按编号排列的项目索引。\n'+
    '\n## 运行环境\n复制清册到工作目录，在支持 Node.js 的计算机运行。\n\n## 操作步骤\n打开终端并运行脚本，核对索引行数和清册。\n';
  const contract = '# 委托开发合同\n软件全称：folio-sort\n版本号：V2.3.0\n著作权归属：'+name+'\n权利范围：全部权利\n';
  const blank = '# 申请确认签章页\n软件全称：folio-sort\n版本号：V2.3.0\n申请人：'+name+'\n申请人签章：［待签］\n';
  const wrongIdentity = '营业执照\n名称：杜鹃编目实验室\n统一社会信用代码：ABC12345678900\n';
  const goodIdentity = wrongIdentity.replace('杜鹃编目', '桐叶索引');
  const first = await uploadZip('R3 非 Rich 模拟材料.zip',{
    'package.json':JSON.stringify({name:'folio-sort',version:'2.3.0',description:'按编号排序'}),
    'src/index.js':'export const sortRows = rows => [...rows].sort();\n',
    '申请表.md':form, '用户手册.md':manual, '附件/主体说明.txt':wrongIdentity,
    '附件/文件甲.txt':contract,'申请确认签章页.md':blank,
    '历史/登记证书.txt':'计算机软件著作权登记证书\n著作权人：历史权利人\n',
    '权属证明.txt':'仅凭文件名不能认定权属。\n',
  },true);
  const check = first.preflight.applicationCheck;
  assert.equal(current(check,'identity').status,'conflict');
  assert.equal(current(check,'rights').status,'review');
  assert.equal(current(check,'signature').status,'missing');
  assert.ok(current(check,'identity').evidence.some(e=>e.path==='申请表.md' && e.value===name && e.location==='第 4 行'));
  assert.ok(current(check,'rights').evidence.some(e=>e.path==='附件/文件甲.txt' && e.value===name));
  assert.deepEqual(current(check,'rights').evidence.filter(e=>e.field==='开发方式').map(e=>e.value),['委托开发']);
  assert.match(current(check,'rights').next,/提供签署完整的委托开发合同/u);
  assert.ok(check.references.some(e=>e.path==='历史/登记证书.txt' && e.value==='历史权利人'));
  assert.ok(!JSON.stringify(check).includes('ABC12345678900'));
  await confirm('V2.3.0');
  const firstAudit = await submit('自动修订并复验','/process');
  assert.equal(r3(firstAudit.audit).formal,0);
  const firstZip = await download(firstAudit.audit,'非Rich－主体不一致.zip');
  const firstUrl = new URL(await bundle().getAttribute('href'),origin);
  assert.ok(firstZip.zip.file('主体权属签章核对.md'));
  const corrected = await uploadZip('R3 更换主体和签章页.zip',{
    '附件/主体说明.txt':goodIdentity,
    '申请确认签章页.md':blank.replace('［待签］',name+' （签章待人工目验）'),
  });
  assert.equal((await page.request.get(firstUrl.href)).status(),409);
  assert.equal(current(corrected.preflight.applicationCheck,'identity').status,'review');
  assert.equal(current(corrected.preflight.applicationCheck,'signature').status,'review');
  await page.reload();
  const region = page.getByRole('region',{name:'R3 申请主体、权属与签章'});
  await region.getByText('签章 · 待人工复核', {exact:true}).waitFor();
  await confirm('V2.3.0');
  const correctedAudit = await submit('自动修订并复验','/process');
  const correctedZip = await download(correctedAudit.audit,'非Rich－换件后.zip');
  assert.equal(r3(correctedZip.receipt).formal,0.5);
  const draft=await correctedZip.zip.file('经审核材料/申报准备/申请表底稿.md').async('string');
  assert.match(draft,/申请人（原件记载，待确认）.*桐叶索引实验室.*申请表\.md/u);
  assert.match(draft,/首次发表地点：待补。/u);
  assert.match(draft,/开发方式（原件记载，待确认）：「委托开发」/u);
  assert.doesNotMatch(draft,/合作开发/u);
  assert.doesNotMatch(draft,/历史权利人|杜鹃编目实验室|ABC12345678900/u);
  const supplement = await correctedZip.zip.file('主体权属签章核对.md').async('string');
  assert.match(supplement,/签章真实性/u);
  assert.doesNotMatch(supplement,/ABC12345678900/u);
  await saveJSON('非Rich网页回执.json',{firstReceipt:firstZip.receipt.id,firstBundle:firstZip.sha256,first:check,
    correctedReceipt:correctedZip.receipt.id,correctedBundle:correctedZip.sha256,corrected:correctedZip.receipt.applicationCheck,
    r3:r3(correctedZip.receipt),oldDownload:409,note:'文书和名称为构造数据，用来验证核对与换件流程。'});
  console.log('非 Rich 回归通过：正文取证、主体冲突、签章待补、历史线索、换件、底稿和回执失效。');
}

try {
  const uploaded = await start([richSource,richRuntime],request);
  const target = await confirm('V1.8.1');
  assert.equal(target.preflight.versionCheck.status,'conflict');
  const audited = await submit('生成版本待核包','/process');
  const artifact = await download(audited.audit,baseline ? 'Rich CLI－v0.3.6网页基线.zip' : 'Rich CLI－R3核对与待补包.zip');
  const data = {url:page.url(),method:audited.method,inputs:uploaded.entries.map(({path,hash})=>({path,hash})),
    preflight:r3(target.preflight.report),final:r3(artifact.receipt),receiptId:artifact.receipt.id,
    artifactSha256:artifact.sha256,actions:artifact.receipt.actions.filter(action=>action.id==='R3')};
  if (baseline) {
    assert.equal(audited.method,'workbench/0.3.6');
    assert.equal(data.final.formal,0.5);
    assert.match(data.final.evidence,/权属或历史附件 1 件/u);
    assert.equal(audited.audit.applicationCheck,undefined);
    assert.equal(artifact.zip.file('主体权属签章核对.md'),null);
    await saveJSON('v0.3.6网页基线回执.json',data);
    console.log('已下载 v0.3.6 同输入基线，复现许可证按文件类别计入 R3 半分。');
  } else {
    const before = JSON.parse(await readFile(join(output,'v0.3.6网页基线回执.json')));
    assert.deepEqual(data.inputs,before.inputs);
    assert.equal(audited.method,'workbench/0.3.8');
    assert.equal(audited.audit.valid,true);
    assert.equal(audited.audit.allowed.length,0);
    assert.equal(audited.candidate.changes.length,0);
    assert.equal(audited.audit.versionCheck.status,'conflict');
    assert.equal(data.final.formal,0);
    const check = audited.audit.applicationCheck;
    for (const item of check.items) {
      assert.equal(item.status,'missing');
      assert.ok(item.owner && item.next);
    }
    assert.ok(check.references.some(item=>item.path==='LICENSE' && item.value==='MIT License' && item.location==='第 1 行'));
    assert.ok(check.references.some(item=>item.path==='LICENSE' && item.value.includes('Will McGugan') && item.location==='第 3 行'));
    assert.ok(check.references.some(item=>item.path==='pyproject.toml' && item.value==='Will McGugan' && item.location==='第 9 行'));
    assert.deepEqual(artifact.receipt.applicationCheck,check);
    const report = await artifact.zip.file('主体权属签章核对.md').async('string');
    assert.match(report,/已读到的本案原件记载[\s\S]*来源线索[\s\S]*缺项与责任人/u);
    assert.doesNotMatch(report,/@gmail\.com/u);
    assert.deepEqual(data.actions.map(action=>action.title),['申请主体','权属','签章']);
    const region=page.getByRole('region',{name:'R3 申请主体、权属与签章'});
    await region.getByText('来源线索',{exact:true}).click();
    await region.screenshot({path:join(output,'Rich CLI－网页R3核对.png')});
    await writeFile(join(output,'主体权属签章核对.md'),report);
    await saveJSON('浏览器回执.json',{...data,check});
    console.log('Rich CLI 同输入网页实下载通过。');
    if (!process.argv.includes('--rich-only')) await genericCase();
  }
  assert.deepEqual(errors,[]);
} finally { await browser.close(); }
