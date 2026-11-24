import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, chrome, JSZip} from '../runtime.mjs';
import {digest} from '../files.mjs';

const origin = process.env.SOFTCERT_ORIGIN;
const output = process.argv[2];
assert.ok(origin && output);
await mkdir(output,{recursive:true});
const browser = await chromium.launch({executablePath:chrome,headless:true});
const name = 'inventory-workflow';
const target = 'V2.3.4';
const action = '点击「导出清单」按钮';
const expected = '清单已导出';
const steps = [
  ['已打开库存清单',action,expected],
  ['浏览器下载已开启','打开下载列表','显示刚导出的清单'],
  ['下载列表已打开','选择最新的库存清单','打开文件'],
  ['库存清单已打开','核对表头中的列名','显示物料编号和仓库名称'],
  ['列名已确认','查看清单记录日期','显示当前筛选日期'],
  ['日期已确认','关闭库存清单','返回下载列表'],
];
const operation = ['功能：导出清单',...steps.flatMap(([before,doAction,result])=>
  ['角色：仓库管理员','前置条件：'+before,'操作：'+doAction,'预期结果：'+result]),'源码：lib/inventory.js:2'];
const source = [
  'export const version = "2.3.4";',
  'export function exportInventory() { return "inventory-exported"; }',
  ...Array.from({length:100},(_,index)=>'export const row'+index+' = '+index+';'),
];

async function pdf(page, pages) {
  const escape = value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  await page.setContent(`<style>
      @page { size:A4; margin:0 }
      body { margin:0; }
      section { position:relative; box-sizing:border-box; padding:86px 64px 0; break-after:page; }
      header { position:absolute; top:40px; left:64px; right:64px; display:flex; justify-content:space-between; }
      .source { font:13px/16.8px Menlo,monospace; white-space:pre; }
      .manual { font:16px/18px Arial,sans-serif; }
      .short { font:16px/21px Arial,sans-serif; }
      </style>`+pages.map(({kind,lines},index)=>'<section class="'+kind+'">'+
      '<header><span>'+name+' '+target+'</span><span>第 '+(index+1)+' 页</span></header>'+
      lines.map(line=>'<div>'+escape(line)+'</div>').join('')+'</section>').join(''));
  return page.pdf({preferCSSPageSize:true});
}

async function download(page,link,filename) {
  const [event] = await Promise.all([page.waitForEvent('download'),link.click()]);
  assert.equal(await event.failure(),null);
  await event.saveAs(join(output,filename));
  return readFile(join(output,filename));
}

try {
  const fixture = await browser.newPage();
  await fixture.setContent('<button>导出清单</button><output></output><span>'+target+'</span>');
  await fixture.addScriptTag({content:source[1].replace('export ','')+
    "\ndocument.querySelector('button').addEventListener('click',()=>{"+
    "document.querySelector('output').textContent=exportInventory()==='inventory-exported' ? '清单已导出' : '导出失败';});"});
  await fixture.getByRole('button',{name:'导出清单'}).click();
  const observed = await fixture.locator('output').textContent();
  const version = await fixture.locator('span').textContent();
  assert.equal(observed,expected);
  const screenshot = await fixture.screenshot();
  const sourceBooklet = await pdf(fixture,[source.slice(0,52),source.slice(52)].map((lines,index)=>({
    kind:'source',lines:lines.map((line,i)=>String(i+1+52*index).padStart(3,'0')+' | '+line),
  })));
  const appendix = Array.from({length:10},(_,index)=>'操作示例 '+(index+1)+'。查看库存记录，核对导出前的物料名称、数量和日期。');
  const manual = await pdf(fixture,[{kind:'manual',lines:['使用说明书','运行环境：在桌面浏览器打开库存页面。',
    ...operation,...appendix]}]);
  // Rasterize a page so the reading service must use OCR. Keep its text
  // separate from the labelled section because OCR is still subject to review.
  await fixture.setContent('<div style="width:720px;background:white;color:black;font:25px/1.55 Arial">'+
    ['运行环境','浏览器显示库存清单。仓库管理员核对导出文件中的名称、数量、日期。','先选择对应仓库，再确认页面顶部的库存总数。',
      '查看清单导出状态。记录待补时在库存页面重新查询。'].join('<br>')+'</div>');
  const scan = await fixture.locator('div').screenshot();
  await fixture.setContent('<style>@page{size:A4;margin:0}</style><img width="640" src="data:image/png;base64,'+
    scan.toString('base64')+'">');
  const scanned = await fixture.pdf({preferCSSPageSize:true});
  await fixture.close();

  const release = new JSZip();
  release.file('package.json',JSON.stringify({name,version:version.slice(1)}));
  release.file('lib/inventory.js',source.join('\n'));
  release.file('tests/inventory.js','throw new Error("tests are outside the deposit scope");');
  const packageZip = await release.generateAsync({type:'nodebuffer'});
  const text = (filename,value)=>({name:filename,mimeType:'text/plain',buffer:Buffer.from(value)});
  const proof = (path,bytes)=>({path,sha256:digest(bytes)});
  const runtimeZip = new JSZip();
  const proofPrefix = '实操证据/';
  runtimeZip.file(proofPrefix+'版本.txt',version);
  runtimeZip.file(proofPrefix+'结果.txt',observed);
  runtimeZip.file(proofPrefix+'界面.png',screenshot);
  const runPath = proofPrefix+'库存.softcert-run.json';
  const record = {
    schema:'softcert-runtime/v1',softwareName:name,version,archiveSha256:digest(packageZip),
    versionProbe:proof(proofPrefix+'版本.txt',version),
    steps:[{mode:'gui',role:'仓库管理员',precondition:'已打开库存清单',action,expected,
      proof:{...proof(proofPrefix+'结果.txt',observed),contains:[expected],screenshot:proof(proofPrefix+'界面.png',screenshot)}}],
  };
  runtimeZip.file(runPath,JSON.stringify(record));
  const generated = [
    text('申请表.txt','软件全称：'+name+'\n版本号：'+target+'\n运行软件环境：浏览器\n主要功能：导出清单\n'),
    {name:'用户说明书.pdf',mimeType:'application/pdf',buffer:manual},
    {name:'扫描操作说明书.pdf',mimeType:'application/pdf',buffer:scanned},
    {name:'程序鉴别材料.pdf',mimeType:'application/pdf',buffer:sourceBooklet},
    {name:'发布源码.zip',mimeType:'application/zip',buffer:packageZip},
    {name:'运行证据.zip',mimeType:'application/zip',buffer:await runtimeZip.generateAsync({type:'nodebuffer'})},
  ];
  const frozenDirectory = process.env.SOFTCERT_FIXTURES || join(output,'工程原件');
  await mkdir(frozenDirectory,{recursive:true});
  const inputs = await Promise.all(generated.map(async input=>{
    const path = join(frozenDirectory,input.name);
    if (!process.env.SOFTCERT_FIXTURES) await writeFile(path,input.buffer);
    return {...input,buffer:await readFile(path)};
  }));
  const page = await browser.newPage({acceptDownloads:true});
  const errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  async function submit(button,route) {
    const [response] = await Promise.all([
      page.waitForResponse(item=>item.request().method()==='POST' && new URL(item.url()).pathname.endsWith(route),{timeout:180000}),
      page.getByRole('button',{name:button,exact:true}).click(),
    ]);
    assert.equal(response.status(),200,await response.text());
    await page.locator('#notice').waitFor({state:'hidden'});
    return response.json();
  }
  await page.goto(origin);
  await page.locator('#request').fill('请核对自备材料，并起草申请表底稿和使用说明书。');
  await page.locator('#files').setInputFiles(inputs);
  await submit('开始预检','/api/cases');
  await page.getByLabel('本次软件版本').fill(target);
  const checked = await submit('确认版本','/target');
  const result = await submit('自动修订并复验','/process');
  const audit = result.audit;
  const linked = page.getByRole('link',{name:'下载内部审阅包'});
  const oldBundle = await linked.getAttribute('href');
  const zipBytes = await download(page,linked,'工程网页下载－内部审阅包.zip');
  const zip = await JSZip.loadAsync(zipBytes);
  const receipt = JSON.parse(await zip.file('审核回执.json').async('string'));
  const inputsHash = inputs.map(input=>[input.name,digest(input.buffer)]);
  const seen = {method:result.method,caseId:audit.caseId,inputs:inputsHash,receipt:audit.id,rules:audit.rules,
    issues:audit.issues,drafts:audit.drafts,allowed:audit.allowed,featureCoverage:audit.featureCoverage,
    scope:checked.preflight.packaged?.paths,ocr:checked.preflight.report.files.find(file=>file.path==='扫描操作说明书.pdf')?.ocr,
    runtime:audit.runtimeEvidence,verifiedSources:audit.verifiedSources,work:audit.work,
    zipSha256:digest(zipBytes),filingReady:audit.filingReady};
  await writeFile(join(output,'网页校验.json'),JSON.stringify(seen,null,2)+'\n');
  console.log(JSON.stringify({method:seen.method,issues:seen.issues,drafts:seen.drafts,scope:seen.scope,
    ocr:seen.ocr,runtime:seen.runtime.records.map(item=>[item.status,item.steps.map(step=>step.status)]),
    workMissing:seen.work.missingDrafts,source:seen.verifiedSources.map(item=>item.matchMode)}));
  assert.equal(receipt.id,audit.id);
  if (process.env.SOFTCERT_PARENT === '1') {
    assert.ok(seen.work.missingDrafts.includes('说明书 PDF'));
    assert.equal(seen.verifiedSources.length,0);
  }
  else {
  assert.deepEqual(seen.scope,['lib/inventory.js']);
  assert.deepEqual(seen.ocr?.pages,[1]);
  assert.equal(seen.featureCoverage.find(item=>item.path==='用户说明书.pdf').features[0].complete,true);
  const [first,...remaining] = seen.featureCoverage.find(item=>item.path==='用户说明书.pdf').features[0].steps;
  assert.equal(first.resultStatus,'同版结果已对照');
  assert.ok(first.runtime.locations.some(location=>location.path==='申报准备/说明书.pdf' && location.page===1));
  assert.ok(remaining.every(step=>step.resultStatus==='实际结果待补'));
  assert.equal(seen.runtime.records[0].steps[0].status,'已对照');
  assert.equal(seen.verifiedSources.find(file=>file.path==='程序鉴别材料.pdf')?.matchMode,'全文行序');
  assert.deepEqual(seen.work.missingDrafts,[]);
  const manualFile = audit.allowed.find(item=>item.kind==='filing-manual');
  assert.ok(manualFile);
  await page.locator('summary').filter({hasText:/^逐件下载/}).click();
  const actualPdf = await download(page,page.getByRole('link',{name:'申报准备/说明书.pdf',exact:true}),'工程网页下载－说明书.pdf');
  assert.equal(digest(actualPdf),manualFile.hash);
  assert.deepEqual(actualPdf,await zip.file('经审核材料/'+manualFile.path).async('nodebuffer'));
  assert.equal(audit.filingReady,false);

  const changedRuntimeZip = await JSZip.loadAsync(inputs.find(input=>input.name==='运行证据.zip').buffer);
  const changedRecord = JSON.parse(await changedRuntimeZip.file(runPath).async('string'));
  changedRecord.steps[0].proof.screenshot.sha256 = '0'.repeat(64);
  changedRuntimeZip.file(runPath,JSON.stringify(changedRecord));
  const changePath = await page.getByRole('link',{name:'申报准备/说明书.pdf',exact:true}).getAttribute('href');
  await page.locator('#files').setInputFiles({name:'运行证据.zip',mimeType:'application/zip',
    buffer:await changedRuntimeZip.generateAsync({type:'nodebuffer'})});
  await submit('保存材料并预检','/intake');
  for (const path of [oldBundle,changePath]) assert.equal((await page.request.get(new URL(path,origin).href)).status(),409);
  await page.getByLabel('本次软件版本').fill(target);
  await submit('确认版本','/target');
  const changed = await submit('自动修订并复验','/process');
  assert.equal(changed.audit.runtimeEvidence.records[0].steps[0]?.status,'运行产物不符',
    JSON.stringify(changed.audit.runtimeEvidence.records[0]));
  assert.equal(changed.audit.featureCoverage.find(item=>item.path==='用户说明书.pdf').features[0].steps[0].resultStatus,'结果或证据不符');
  assert.equal(changed.audit.filingReady,false);
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'网页校验.json'),JSON.stringify({...seen,standalonePdfSha256:digest(actualPdf),
    staleDownloads:409,changedScreenshot:changed.audit.runtimeEvidence.records[0].steps[0].status},null,2)+'\n');
  }
} finally {
  await browser.close();
}
