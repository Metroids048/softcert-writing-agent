import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, chrome, JSZip, archive, root } from '../runtime.mjs';
import { digest } from '../files.mjs';

const output = process.argv[2];
assert.ok(output,'An evidence directory is required');
await mkdir(output,{recursive:true});
const data = await mkdtemp(join(tmpdir(),'softcert-e2e-'));
const browser = await chromium.launch({executablePath:chrome,headless:true});
let server,origin;
const log = [];
const timings = {};
const sample = join(archive,'04 模拟样例与网页原型/网页产物');
const micro = join(archive,'02 Microblog 开源实跑');
const payload = (name,buffer)=>({name,mimeType:'application/octet-stream',buffer});
const state = async page => {
  const href=new URL(page.url());
  const response=await page.request.get(new URL('/api/cases/'+href.searchParams.get('case'),href).href);
  assert.equal(response.status(),200);
  return response.json();
};
async function start() {
  server=spawn(process.execPath,[join(root,'app/server.mjs')],{env:{...process.env,SOFTCERT_PORT:'0',SOFTCERT_DATA:data},stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>server.kill(),12000);
  server.stderr.on('data',part=>log.push(part.toString()));
  try {
    const [chunk]=await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Server exited');})]);
    origin=chunk.toString().trim();
    assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/u);
  } finally {clearTimeout(timer);}
}
async function stop() {
  if(server?.exitCode === null) {const closed=once(server,'exit');server.kill();await closed;}
}
async function upload(page, files, isNew=true) {
  await page.locator('#files').setInputFiles(files);
  const responseEvent=page.waitForResponse(response=>response.request().method()==='POST' &&
    /\/api\/cases(?:\/[a-f\d-]+\/intake)?$/.test(response.url()),{timeout:90000});
  await page.getByRole('button',{name:isNew?'开始预检':'保存材料并预检',exact:true}).click();
  const response=await responseEvent;
  assert.equal(response.status(),200,await response.text());
  await page.locator('#notice').waitFor({state:'hidden'});
  return state(page);
}
async function processCase(page) {
  const event=page.waitForResponse(response=>response.request().method()==='POST' && response.url().endsWith('/process'),{timeout:120000});
  await page.locator('#process').click();
  const response=await event;
  assert.equal(response.status(),200,await response.text());
  await page.getByText('终件复验',{exact:true}).waitFor();
  await page.locator('#notice').waitFor({state:'hidden'});
  return state(page);
}
async function save(page,name,link=page.getByRole('link',{name:'下载内部审阅包'})) {
  const [download]=await Promise.all([page.waitForEvent('download'),link.click()]);
  assert.equal(await download.failure(),null);
  const target=join(output,name);
  await download.saveAs(target);
  const bytes=await readFile(target);
  return {sha256:digest(bytes),bytes};
}
const json = (zip,name)=>zip.file(name).async('string').then(JSON.parse);
const attachmentBytes = (zip,path)=>zip.file('经审核材料/'+path).async('nodebuffer');
const stale = async (page,href)=>assert.equal((await page.request.get(new URL(href,page.url()).href)).status(),409);
const requestExample = '我们要给这个版本办软著，源码和旧手册都在包里。能确认的请直接改到 Word 副本里，给我审一下原件和改动。还要我补什么，列给我。';

try {
  await start();
  const context=await browser.newContext({viewport:{width:1410,height:980}});
  const page=await context.newPage();
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  const runs={};
  const evidence = (before,after,sha256)=>({
    caseId:after.id,revision:after.revision, preflight:before.preflight, candidate:after.candidate,
    audit:after.audit, archiveSha256:sha256, durationMs:timings[after.id],
  });
  const startCase = async (files, folder)=>{
    const startTime=Date.now();
    await page.goto(origin);
    await page.locator('#request').fill(requestExample);
    if (folder) {
      await page.locator('#folder').setInputFiles(folder);
      await page.getByText(/忽略 1 件/).waitFor();
    }
    const before=await upload(page,files);
    return {before,startTime};
  };
  const finish = async (before,startTime,filename)=>{
    const after=await processCase(page);
    const saved=await save(page,filename);
    timings[after.id]=Date.now()-startTime;
    const zip=await JSZip.loadAsync(saved.bytes);
    assert.equal((await json(zip,'审核回执.json')).id,after.audit.id);
    assert.equal(after.audit.rows.length,7);
    assert.equal(after.audit.filingReady,false);
    return {after,saved,zip};
  };
  const deviceInput=join(sample,'自动修订版/模拟输入－设备预约台.zip');
  const device=await startCase([deviceInput]);
  assert.equal(device.before.preflight.report.quality,85.7);
  assert.equal(device.before.preflight.duplicates.length,1);
  const first=await finish(device.before,device.startTime,'设备预约台－内部审阅包.zip');
  assert.equal(first.after.audit.runtimeEvidence.matched,0);
  assert.deepEqual(first.after.audit.runtimeEvidence.records,[]);
  assert.equal(first.after.audit.rows.find(row=>row.id==='R5').formal,0);
  assert.equal(first.after.candidate.changes.length,4);
  assert.equal(first.after.audit.issues.length,0);
  assert.ok(first.after.audit.actions.some(item=>item.title.includes('批量预约')));
  assert.equal(first.after.candidate.upstream.commit,'ee7d4636f35210767adc0b5689f8678c68e6f7e6');
  assert.ok(first.after.audit.allowed.some(item=>item.kind==='manual-pdf'));
  assert.ok(!first.after.audit.allowed.some(item=>item.kind==='source-pdf'));
  assert.ok(first.after.audit.drafts.some(item=>item.file.kind==='source-pdf' && /不足 50 行/.test(item.reason)));
  const allowedFile=first.after.audit.allowed.find(file=>file.kind==='editable' && file.path.endsWith('.docx'));
  assert.ok(allowedFile);
  await page.getByText(/^逐件下载/).click();
  const individual=await save(page,'设备预约台－逐件下载.docx',page.getByRole('link',{name:allowedFile.path,exact:true}));
  assert.equal(individual.sha256,allowedFile.hash);
  await page.screenshot({path:join(output,'设备预约台－网页终件复验.png'),fullPage:true});
  runs.device=evidence(device.before,first.after,first.saved.sha256);
  const bundleLink=await page.getByRole('link',{name:'下载内部审阅包'}).getAttribute('href');
  const individualLink=await page.getByRole('link',{name:allowedFile.path,exact:true}).getAttribute('href');
  await stop();
  await start();
  await page.goto(origin+'/?case='+first.after.id);
  await page.getByRole('link',{name:'下载内部审阅包'}).waitFor();
  assert.equal((await state(page)).audit.id,first.after.audit.id);
  const blob=join(data,'blobs',allowedFile.hash);
  const savedBlob=await readFile(blob);
  await writeFile(blob,Buffer.from('replaced after review'));
  await stale(page,individualLink);
  await stale(page,bundleLink);
  await writeFile(blob,savedBlob);

  const inputArchive=await JSZip.loadAsync(await readFile(deviceInput));
  for (const file of first.after.audit.allowed.filter(item=>item.kind==='editable')) {
    inputArchive.file(file.path,await attachmentBytes(first.zip,file.path));
  }
  await upload(page,[payload('设备预约台－回传已写回材料.zip',await inputArchive.generateAsync({type:'nodebuffer'}))],false);
  await stale(page,bundleLink);
  await stale(page,individualLink);
  const second=await processCase(page);
  assert.equal(second.candidate.changes.length,0);
  assert.equal(second.audit.issues.length,0);
  const secondLink=await page.getByRole('link',{name:'下载内部审阅包'}).getAttribute('href');
  const versionPath='研发/发布版/VERSION';
  const conflicting=new JSZip();
  conflicting.file(versionPath,'9.9.0\n');
  await upload(page,[payload('同路径换件.zip',await conflicting.generateAsync({type:'nodebuffer'}))],false);
  await stale(page,secondLink);
  const wrong=await processCase(page);
  assert.equal(wrong.candidate.changes.length,0);
  assert.ok(wrong.audit.issues.some(item=>item.id==='R2'));
  assert.ok(wrong.audit.blocked.includes(allowedFile.path));
  const wrongLink=await page.getByRole('link',{name:'下载内部审阅包'}).getAttribute('href');
  const repair=new JSZip();
  repair.file(versionPath,await inputArchive.file(versionPath).async('nodebuffer'));
  await upload(page,[payload('恢复正确版本.zip',await repair.generateAsync({type:'nodebuffer'}))],false);
  await stale(page,wrongLink);
  const restored=await processCase(page);
  assert.notEqual(restored.audit.id,first.after.audit.id);
  assert.equal(restored.audit.blocked.length,0);
  await stale(page,bundleLink);
  const restoredLink=await page.getByRole('link',{name:'下载内部审阅包'}).getAttribute('href');
  await page.locator('summary').filter({hasText:'原件清单'}).click();
  await page.getByRole('button',{name:'撤回 '+versionPath,exact:true}).click();
  await page.locator('#notice').waitFor({state:'hidden'});
  assert.ok(!(await state(page)).entries.some(file=>file.path===versionPath));
  await stale(page,restoredLink);
  runs.deviceLifecycle={restarted:true,tampered:[409,409],reuploadEdits:second.candidate.changes.length,
    conflict:wrong.audit.issues, restored:restored.audit.id, revokedAfterChanges:[bundleLink,secondLink,wrongLink,restoredLink].length,
    oldIndividualRefused:true};

  const manuals=(await readdir(join(micro,'实际输出'))).filter(name=>/操作手册|申请表信息/.test(name)).map(name=>join(micro,'实际输出',name));
  const microRun=await startCase([join(micro,'Microblog 固定提交－源码.zip'),...manuals,
    join(micro,'复验与失败证据/first-material-failure/manual.pdf')]);
  await page.getByLabel('本次软件版本').fill('V1.0');
  await page.getByLabel('确认采用此固定源码快照').check();
  await page.getByRole('button',{name:'确认版本',exact:true}).click();
  await page.locator('#notice').waitFor({state:'hidden'});
  const locked=await state(page);
  assert.equal(locked.target.snapshot,'a975ef64864354867c88e0ed3a17ba7d17dca752');
  const microResult=await finish(locked,microRun.startTime,'Microblog－内部审阅包.zip');
  const microAudit=microResult.after.audit;
  assert.equal(microAudit.issues.filter(item=>item.id==='R5').length,2);
  assert.ok(microAudit.issues.some(item=>item.id==='R6' && item.detail.includes('软件概述') && item.detail.includes('3 页')));
  assert.ok(microAudit.issues.some(item=>item.id==='R6' && item.path==='manual.pdf'));
  assert.ok(microAudit.allowed.some(item=>item.kind==='source-pdf'));
  assert.ok(!microAudit.allowed.some(item=>/操作手册|^manual\.pdf/.test(item.path)));
  runs.microblog=evidence(locked,microResult.after,microResult.saved.sha256);

  const hollow=await startCase([join(sample,'Hollow－脱敏原始材料.zip')]);
  const historicalFirst=await finish(hollow.before,hollow.startTime,'Hollow－首次内部审阅包.zip');
  assert.ok(historicalFirst.after.preflight.historical);
  assert.ok(historicalFirst.after.preflight.report.sourcePages.some(file=>file.pageCount===29));
  assert.ok(historicalFirst.after.audit.allowed.some(file=>file.kind==='historical-source-original'));
  assert.ok(historicalFirst.after.audit.applicationCheck.references.some(item=>item.field.startsWith('历史')));
  assert.ok(historicalFirst.after.audit.actions.some(item=>item.id==='R3' && item.title==='签章'));
  const priorHistory=await page.getByRole('link',{name:'下载内部审阅包'}).getAttribute('href');
  const corrected=join(archive,'03 Hollow 历史公开案卷/真实软著案卷复验/设计说明书（整理版）.pdf');
  const supplement=await upload(page,[corrected],false);
  await stale(page,priorHistory);
  assert.ok(hollow.before.entries.every(file=>supplement.entries.some(next=>next.path===file.path && next.hash===file.hash)));
  const history=await finish(supplement,hollow.startTime,'Hollow－补件后内部审阅包.zip');
  assert.ok(history.after.audit.observations.some(item=>item.detail.includes('26 个')));
  assert.ok(history.after.audit.allowed.some(item=>item.kind==='historical-reviewed-manual'));
  runs.hollow=evidence(supplement,history.after,history.saved.sha256);
  runs.hollowBefore=evidence(hollow.before,historicalFirst.after,historicalFirst.saved.sha256);

  const holdout=await startCase([join(sample,'模拟输入－库存盘点助手.zip')]);
  const stock=await finish(holdout.before,holdout.startTime,'库存盘点助手－内部审阅包.zip');
  assert.ok(stock.after.preflight.report.files.length>=3);
  runs.stock=evidence(holdout.before,stock.after,stock.saved.sha256);

  const sparse = new JSZip();
  sparse.file('pyproject.toml','[project]\nname = "note-sift"\nversion = "0.4.0"\nrequires-python = ">=3.10"\n[project.scripts]\nnote-sift = "note_sift:main"\n');
  sparse.file('README.md','# Note Sift\n\nThis tool sorts a local text file into a list of unique notes.\n\n## Usage\n\nStart the command with the path to the input file.\n\n```sh\nnote-sift notes.txt\n```\n');
  sparse.file('src/note_sift.py',`from pathlib import Path
import sys

def main():
    lines = Path(sys.argv[1]).read_text().splitlines()
    notes = sorted(set(filter(None, lines)))
    sys.stdout.write("\\n".join(notes))
`);
  const weak = await startCase([payload('note-sift-v0.4.0.zip',await sparse.generateAsync({type:'nodebuffer'}))]);
  await page.getByLabel('本次软件版本').fill('V0.4.0');
  await page.getByRole('button',{name:'确认版本',exact:true}).click();
  await page.locator('#notice').waitFor({state:'hidden'});
  const thin = await finish(await state(page),weak.startTime,'弱材料通用回归－内部审阅包.zip');
  assert.ok(thin.after.audit.allowed.some(item=>item.kind==='filing-form'));
  assert.ok(thin.after.audit.allowed.some(item=>item.kind==='filing-checklist'));
  assert.ok(!thin.after.audit.allowed.some(item=>['filing-manual','source-pdf'].includes(item.kind)));
  assert.ok(thin.after.audit.drafts.some(item=>item.file.kind==='filing-manual'));
  assert.match((await attachmentBytes(thin.zip,'申报准备/申请人补件清单.md')).toString(),
    /环境与准备|输出、结果与异常/);
  const weakDownload=await page.getByRole('link',{name:'下载内部审阅包'}).getAttribute('href');
  const supplementZip = new JSZip();
  supplementZip.file('RID-0.4.md','Supplemental notes for the package.\n');
  await upload(page,[payload('补件.zip',await supplementZip.generateAsync({type:'nodebuffer'}))],false);
  await stale(page,weakDownload);
  runs.weak={...evidence(weak.before,thin.after,thin.saved.sha256),staleDownloadRejected:true};

  const folder=join(data,'研发');
  const release=join(folder,'发布版');
  await mkdir(release,{recursive:true});
  const lines = Array.from({length:3900},(_,index) => 'item_'+(index+1)+' = '+(index+1)).join('\n');
  await writeFile(join(release,'reservation-data.py'),lines+'\n');
  await writeFile(join(folder,'.workspace-marker'),'Mock ignored dotfile\n');
  const big = await startCase([deviceInput],folder);
  assert.ok(big.before.entries.some(file=>file.path==='研发/发布版/reservation-data.py'));
  assert.ok(!big.before.entries.some(file=>file.path.includes('.workspace-marker')));
  const split = await finish(big.before,big.startTime,'长交存－前后分册验收包.zip');
  for (const volume of ['front_30','back_30']) {
    assert.ok(split.after.audit.allowed.some(file=>file.kind==='source-pdf' && file.volume===volume && file.expectedPages===30));
  }
  runs.long={...evidence(big.before,split.after,split.saved.sha256),directoryUpload:true};

  assert.deepEqual(pageErrors,[]);
  const fileHashes={};
  for (const path of (await readdir(output)).filter(path=>/\.(zip|png|docx)$/.test(path))) {
    fileHashes[path]=digest(await readFile(join(output,path)));
  }
  await writeFile(join(output,'browser-evidence.json'),JSON.stringify({runs,fileHashes,ranAt:new Date().toISOString()},null,2));
  console.log('浏览器验证完成：4 个归档案卷、1 个弱材料样本及 1 个长交存边界样本。');
} catch(error) {
  console.error(log.join('').slice(-2000));
  throw error;
} finally {
  await browser.close();
  await stop();
  await rm(data,{recursive:true,force:true});
}
