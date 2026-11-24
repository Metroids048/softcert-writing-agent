import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, chrome, JSZip} from '../runtime.mjs';
import {digest} from '../files.mjs';

const origin = process.env.SOFTCERT_ORIGIN;
const output = process.argv[2];
if (!origin || !output) throw new Error('请设置 SOFTCERT_ORIGIN 并提供验证输出目录。');
await mkdir(output,{recursive:true});
const browser = await chromium.launch({executablePath:chrome,headless:true});
try {
  const fixtures = await browser.newPage();
  async function pdf(name,count) {
    await fixtures.setContent('<style>section+section{break-before:page}</style>'+Array.from({length:count},(_,index)=>
      '<section>Workflow reader fixture '+count+' pages, type '+(name.startsWith('程序')?'source':'manual')+
      ', operation text on document page '+(index+1)+'</section>').join(''));
    const bytes = await fixtures.pdf({format:'A4'});
    // Fix Chromium's metadata timestamp without moving PDF cross-reference offsets.
    const buffer = Buffer.from(bytes.toString('latin1').replace(/D:\d{14}/g,'D:20000101000000'),'latin1');
    return {name,mimeType:'application/pdf',buffer};
  }
  const short = await pdf('用户说明书.pdf',1);
  const replacement = await pdf(short.name,2);
  const long = await pdf('长篇操作手册.pdf',241);
  const source = await pdf('程序鉴别材料.pdf',1);
  await fixtures.setContent('<div style="font:24px Arial">Inventory export result. Verify date, warehouse and quantity.</div>');
  const raster = await fixtures.locator('div').screenshot();
  await fixtures.setContent('<style>section+section{break-before:page}</style>'+
    '<section>Read this original page before running the program.</section>'.repeat(210)+
    '<section><img width="620" src="data:image/png;base64,'+raster.toString('base64')+'"></section>');
  const lateScan = await fixtures.pdf({format:'A4'});
  await fixtures.setContent('<style>section+section{break-before:page}</style>'+
    '<section><p>功能：保存清单</p><p>角色：仓库管理员</p><p>前置条件：已打开清单</p><p>操作：请打开工作台，</p></section>'+
    '<section><p>选择仓库并确认保存。</p><p>预期结果：清单保存成功</p></section>');
  const brokenStep = await fixtures.pdf({format:'A4'});
  await fixtures.close();
  const page = await browser.newPage({acceptDownloads:true});
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  async function submit(button,route) {
    const [response] = await Promise.all([
      page.waitForResponse(item=>item.request().method()==='POST' && new URL(item.url()).pathname.endsWith(route),{timeout:120000}),
      page.getByRole('button',{name:button,exact:true}).click(),
    ]);
    assert.equal(response.status(),200,await response.text());
    await page.locator('#notice').waitFor({state:'hidden'});
    return response.json();
  }
  await page.goto(origin);
  await page.locator('#request').fill('我已上传原件，帮我整理完整的软著材料。');
  await page.locator('#files').setInputFiles([short,long,source]);
  const intake = await submit('开始预检','/api/cases');
  const result = await submit('自动修订并复验','/process');
  const link = page.getByRole('link',{name:'下载内部审阅包'});
  const stalePath = await link.getAttribute('href');
  const [download] = await Promise.all([page.waitForEvent('download'),link.click()]);
  const location = join(output,'技术验证下载.zip');
  await download.saveAs(location);
  const zip = await JSZip.loadAsync(await readFile(location));
  const report = await zip.file('审核报告.md').async('string');
  const receipt = JSON.parse(await zip.file('审核回执.json').async('string'));
  await page.reload();
  await link.waitFor();
  await page.locator('#files').setInputFiles(replacement);
  const updated = await submit('保存材料并预检','/intake');
  const stale = await page.request.get(new URL(stalePath,origin).href);
  const snapshot = {
    method:result.method,rules:receipt.rules,sourceRole:intake.preflight.report.files.find(item=>item.path===source.name).role,
    inputs:[short,long,source].map(file=>({path:file.name,sha256:digest(file.buffer)})),
    longPages:intake.preflight.report.files.find(item=>item.path===long.name).pageCount,
    preflight:intake.preflight.work ?? null,work:receipt.work ?? null,
    manualStatus:receipt.selfReview.reviews.find(item=>item.path===short.name)?.status ?? null,
    shortApproved:receipt.allowed.some(item=>item.path===short.name),
    shortDraft:!!zip.file('待核草稿/'+short.name),longApproved:receipt.allowed.some(item=>item.path===long.name),
    originalRetained:!!zip.file('待核原件/'+long.name) || !!zip.file('参考原件/'+long.name),
    reportStatesMissing:report.includes('本次应交材料未齐'),reportStatesPage:report.includes('第 241 页未读取'),
    auditCleared:!updated.audit,changedWork:updated.preflight.work?.id !== intake.preflight.work?.id,staleStatus:stale.status(),errors,
  };
  await writeFile(join(output,'observed.json'),JSON.stringify(snapshot,null,2)+'\n');
  console.log(JSON.stringify(snapshot));
  assert.equal(snapshot.sourceRole,'source');
  assert.equal(snapshot.longPages,241);
  assert.equal(snapshot.preflight.draftRequested,true);
  assert.deepEqual(snapshot.work.missingDrafts,['申请表底稿','说明书 PDF']);
  assert.deepEqual(snapshot.work.expected,['form','manual','source']);
  assert.deepEqual(snapshot.work.missingDeliverables,['申请表底稿','说明书 PDF','源程序交存 PDF']);
  assert.ok(receipt.rows.find(row=>row.id==='R1').quality < 1);
  assert.match(receipt.rows.find(row=>row.id==='R4').evidence,/源程序交存 PDF/u);
  assert.equal(snapshot.manualStatus,'范围待核');
  assert.equal(snapshot.shortApproved,false);
  assert.equal(snapshot.shortDraft,true);
  assert.equal(snapshot.longApproved,false);
  assert.equal(snapshot.originalRetained,true);
  assert.equal(snapshot.reportStatesMissing,true);
  assert.equal(snapshot.reportStatesPage,true);
  assert.equal(snapshot.auditCleared,true);
  assert.equal(snapshot.changedWork,true);
  assert.equal(snapshot.staleStatus,409);
  assert.deepEqual(errors,[]);

  await page.goto(origin);
  await page.locator('#request').fill('请按原件整理使用说明书。');
  await page.locator('#files').setInputFiles([
    {name:'长扫描说明书.pdf',mimeType:'application/pdf',buffer:lateScan},
    {name:'跨页说明书.pdf',mimeType:'application/pdf',buffer:brokenStep},
  ]);
  const scanIntake = await submit('开始预检','/api/cases');
  const scanReport = scanIntake.preflight.report.files.find(file=>file.path==='长扫描说明书.pdf');
  const continued = scanIntake.preflight.work.features.manuals.find(manual=>manual.path==='跨页说明书.pdf').features[0];
  assert.equal(scanReport.readPages,211);
  assert.deepEqual(scanReport.ocr,{pages:[211],unresolved:[],unavailable:false});
  assert.deepEqual(continued.boundaryGaps,[{from:1,to:2}]);
  assert.equal(continued.complete,false);
  const scanResult = await submit('自动修订并复验','/process');
  const scanLink = page.getByRole('link',{name:'下载内部审阅包'});
  const [scanDownload] = await Promise.all([page.waitForEvent('download'),scanLink.click()]);
  const scanPath = join(output,'长件与跨页－实际网页下载.zip');
  await scanDownload.saveAs(scanPath);
  const scanBytes = await readFile(scanPath);
  const scanZip = await JSZip.loadAsync(scanBytes);
  const scanBundleReport = await scanZip.file('审核报告.md').async('string');
  assert.match(scanBundleReport,/第 1、2 页的操作字段疑有跨页续文/u);
  const transcript = scanResult.audit.transcripts.find(item=>item.original==='长扫描说明书.pdf');
  assert.ok(transcript);
  assert.match(await scanZip.file('识别文本/'+transcript.path).async('string'),/【原 PDF 第 211 页】\s*Inventory export result/u);
  await writeFile(join(output,'scan-observed.json'),JSON.stringify({method:scanResult.method,receipt:scanResult.audit.id,
    readPages:scanReport.readPages,ocr:scanReport.ocr,boundary:continued.boundaryGaps,zipSha256:digest(scanBytes)},null,2)+'\n');

  const release = new JSZip();
  release.file('package.json',JSON.stringify({name:'workflow-fixture',version:'1.2.3'}));
  release.file('src/workflow.js',Array.from({length:52},(_,index)=>'export const row'+index+' = '+index+';').join('\n'));
  await page.goto(origin);
  await page.locator('#request').fill('请按上传版本整理源码交存。');
  await page.locator('#files').setInputFiles({name:'workflow-release.zip',mimeType:'application/zip',
    buffer:await release.generateAsync({type:'nodebuffer'})});
  await submit('开始预检','/api/cases');
  await page.getByLabel('本次软件版本').fill('1.2.3');
  await submit('确认版本','/target');
  const composed = await submit('自动修订并复验','/process');
  assert.deepEqual(composed.audit.work.expected,['source']);
  assert.deepEqual(composed.audit.work.missingDeliverables,[]);
  assert.equal(composed.candidate.upstream?.commit,'ee7d4636f35210767adc0b5689f8678c68e6f7e6');
  const reviewedSource = composed.audit.allowed.find(file=>file.kind==='source-pdf');
  assert.ok(reviewedSource);
  await page.locator('summary').filter({hasText:/^逐件下载/}).click();
  const [sourceDownload] = await Promise.all([page.waitForEvent('download'),
    page.getByRole('link',{name:'交存源码－全部.pdf',exact:true}).click()]);
  const sourcePath = join(output,'技术验证源码册.pdf');
  await sourceDownload.saveAs(sourcePath);
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sourceBytes.subarray(0,5).toString(),'%PDF-');
  assert.equal(digest(sourceBytes),reviewedSource.hash);
  assert.equal(composed.audit.work.deliverables[0].files[0].sha256,reviewedSource.hash);
  const oldBundle = await page.getByRole('link',{name:'下载内部审阅包'}).getAttribute('href');
  await page.locator('#custom-scope').check();
  await page.locator('#material-selection input[value="manual"]').check();
  await page.locator('#material-selection input[value="source"]').uncheck();
  const changed = await submit('确认版本','/target');
  assert.deepEqual(changed.preflight.work.expected,['manual']);
  assert.equal(changed.audit,null);
  assert.equal((await page.request.get(new URL(oldBundle,origin).href)).status(),409);
  await writeFile(join(output,'source-observed.json'),JSON.stringify({
    method:composed.method,upstream:composed.candidate.upstream,downloaded:reviewedSource,
  },null,2)+'\n');
  assert.deepEqual(errors,[]);
} finally {
  await browser.close();
}
