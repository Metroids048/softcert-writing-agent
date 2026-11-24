import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {JSZip,chromium,chrome} from '../runtime.mjs';
import {digest} from '../files.mjs';

const origin = process.env.SOFTCERT_ORIGIN ?? 'http://127.0.0.1:8793';
const path = '清册工具操作说明书.md';
const operation = '选择保存的清册，在命令行中运行整理任务，运行后可以查看输出并保存截图。';
const safe = '# 清册工具 V2.0 说明书\n\n## 操作步骤\n'+operation+'\n';
const unsafe = safe+'\n本说明书所有截图由软件在实际运行时截取。\n';
const browser = await chromium.launch({executablePath:chrome,headless:true});
const page = await browser.newPage();

async function submit(button,route) {
  const [response] = await Promise.all([
    page.waitForResponse(item=>item.request().method()==='POST' && new URL(item.url()).pathname.endsWith(route)),
    page.getByRole('button',{name:button,exact:true}).click(),
  ]);
  assert.equal(response.status(),200,await response.text());
  await page.locator('#notice').waitFor({state:'hidden'});
  return response.json();
}

const upload = text => page.locator('#files').setInputFiles({name:path,mimeType:'text/markdown',buffer:Buffer.from(text)});
async function download(audit) {
  const link = page.getByRole('link',{name:'下载内部审阅包',exact:true});
  const url = new URL(await link.getAttribute('href'),origin).href;
  const [download] = await Promise.all([page.waitForEvent('download'),link.click()]);
  const bytes = await readFile(await download.path());
  const zip = await JSZip.loadAsync(bytes,{checkCRC32:true});
  const receipt = JSON.parse(await zip.file('审核回执.json').async('string'));
  assert.equal(receipt.id,audit.id);
  return {url,zip,receipt,hash:digest(bytes)};
}

try {
  await page.goto(origin);
  await page.locator('#request').fill('请审核我提供的操作材料，保留有待核对的原件。');
  await upload(unsafe);
  await submit('开始预检','/api/cases');
  const first = await submit('自动修订并复验','/process');
  const rejected = await download(first.audit);
  assert.equal(rejected.receipt.rows.find(row=>row.id==='R7').quality,0);
  assert.ok(rejected.receipt.issues.some(hit=>hit.id==='R7' && hit.path===path && hit.location==='正文'));
  assert.equal(rejected.zip.file('经审核材料/'+path),null);
  assert.equal(await rejected.zip.file('待核原件/'+path).async('string'),unsafe);

  await upload(safe);
  await submit('保存材料并预检','/intake');
  assert.equal((await page.request.get(rejected.url)).status(),409);
  const second = await submit('自动修订并复验','/process');
  const released = await download(second.audit);
  assert.ok(!released.receipt.issues.some(hit=>hit.id==='R7'));
  assert.equal(await released.zip.file('经审核材料/'+path).async('string'),safe);
  const evidence = {fixture:'构造的操作说明书，验证原文独立交存及换件复验',caseId:rejected.receipt.caseId,
    before:{inputHash:digest(Buffer.from(unsafe)),receipt:rejected.receipt.id,archiveHash:rejected.hash,
      disposition:rejected.receipt.disposition,findings:rejected.receipt.issues.filter(hit=>hit.id==='R7')},
    after:{inputHash:digest(Buffer.from(safe)),receipt:released.receipt.id,archiveHash:released.hash,
      disposition:released.receipt.disposition},oldDownloadStatus:409};
  if (process.argv[2]) await writeFile(process.argv[2],JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
