import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium, chrome, JSZip, root} from '../runtime.mjs';
import {digest} from '../files.mjs';

const [application, output, mode] = process.argv.slice(2);
assert.ok(application && output && ['parent','candidate'].includes(mode));
const destination = resolve(output);
const data = join(destination, '隔离案卷');
await mkdir(data, {recursive:true});
const server = spawn(join(resolve(application),'app/start.sh'), [], {
  env:{...process.env,SOFTCERT_PORT:'0',SOFTCERT_DATA:data}, stdio:['ignore','pipe','inherit'],
});
const deadline = setTimeout(()=>server.kill(),15000);
let browser;
try {
  const [chunk] = await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Server exited');})]);
  clearTimeout(deadline);
  const origin = chunk.toString().trim();
  assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/u);
  const directory = join(root,'运行证据/v0.3.21-中文新案双测-2026-11-23/亲戚关系计算器');
  const input = JSON.parse(await readFile(join(directory,'冻结上传.json'),'utf8'));
  const uploads = await Promise.all(input.files.map(async file=>{
    const path=join(directory,file.path);
    assert.equal(digest(await readFile(path)),file.sha256,file.path);
    return path;
  }));
  browser = await chromium.launch({executablePath:chrome,headless:true});
  const cases = [
    ['仅说明书','请只生成说明书 PDF，申请表和源码交存件先不用给。',['manual']],
    ['同义三件套','按附件拆成三份：登记表、操作手册和交存源码 PDF。',['form','manual','source']],
  ];
  for (const [key,request,expected] of cases) {
    const page=await browser.newPage();
    const collect=async (suffix, click)=>{
      const received=page.waitForResponse(response=>response.request().method()==='POST' &&
        new URL(response.url()).pathname.endsWith(suffix),{timeout:240000});
      await click();
      const response=await received;
      assert.equal(response.status(),200,await response.text());
      await page.locator('#notice').waitFor({state:'hidden',timeout:240000});
      return response.json();
    };
    await page.goto(origin);
    await page.locator('#request').fill(request);
    await page.locator('#files').setInputFiles(uploads);
    const before = await collect('/api/cases',()=>page.getByRole('button',{name:'开始预检',exact:true}).click());
    await writeFile(join(destination,key+'-预检.json'),JSON.stringify({origin,request,input:input.files,expected,response:before},null,2)+'\n');
    await page.screenshot({path:join(destination,key+'-预检.png'),fullPage:true});
    console.log(JSON.stringify({mode,key,expected,actual:before.preflight.work.expected,action:before.preflight.work.mode}));
    if (mode === 'candidate') {
      assert.deepEqual(before.preflight.work.expected,expected);
      assert.equal(before.preflight.work.mode,'draft');
      await page.locator('#software-name').fill('中国亲戚关系计算器');
      await page.locator('#version').fill(input.version);
      await collect('/target',()=>page.getByRole('button',{name:'确认版本',exact:true}).click());
      const result=await collect('/process',()=>page.getByRole('button',{name:'自动修订并复验',exact:true}).click());
      await writeFile(join(destination,key+'-终检.json'),JSON.stringify(result,null,2)+'\n');
      const [download] = await Promise.all([page.waitForEvent('download'),
        page.getByRole('link',{name:'下载内部审阅包',exact:true}).click()]);
      assert.equal(await download.failure(),null);
      const bundle=join(destination,key+'-实际下载.zip');
      await download.saveAs(bundle);
      const zip=await JSZip.loadAsync(await readFile(bundle));
      const receipt=JSON.parse(await zip.file('审核回执.json').async('string'));
      assert.equal(receipt.id,result.audit.id);
      assert.deepEqual(receipt.work.deliverables.map(item=>item.key),expected);
      assert.ok(receipt.work.deliverables.every(item=>item.status==='经审核'));
      if (key==='仅说明书') {
        assert.deepEqual(receipt.work.deliverables[0].files.map(file=>file.path),['经审核材料/申报准备/说明书.pdf']);
        assert.ok(receipt.allowed.every(file=>!['filing-form','source-pdf','filing-manual-text'].includes(file.kind)));
      }
      for (const item of receipt.work.deliverables.flatMap(item=>item.files)) {
        assert.equal(digest(await zip.file(item.path).async('nodebuffer')),item.sha256);
      }
      if (key==='同义三件套') {
        const save=async name=>{
          const [download]=await Promise.all([page.waitForEvent('download'),
            page.getByRole('link',{name:'下载内部审阅包',exact:true}).click()]);
          await download.saveAs(join(destination,name+'-实际下载.zip'));
        };
        const record=async (name,changed)=>{
          await writeFile(join(destination,name+'.json'),JSON.stringify(changed,null,2)+'\n');
        };
        let previous=result;
        const requests=[
          ['改为一件',cases[0][1],['manual'],['form','source'],[]],
          ['补回源码','请保留现有说明书 PDF 和原有步骤，再补回源码交存 PDF，暂不交申请表。',['manual','source'],[],['source']],
          ['只读审核','仅复核已有说明书和源码交存件，不用起草。',['manual','source'],[],[]],
        ];
        for(const [name,wording,expected,removed,added] of requests){
          const previousUrl=origin+'/api/cases/'+previous.id+'/download/'+previous.audit.id;
          await page.locator('#saved-request').fill(wording);
          const changed=await collect('/request',()=>page.getByRole('button',{name:'更新本案说明',exact:true}).click());
          const oldZip=await page.request.get(previousUrl+'/bundle');
          const oldFile=await page.request.get(previousUrl+'/0');
          assert.equal(oldZip.status(),409);
          assert.equal(oldFile.status(),409);
          assert.equal(changed.target.version,input.version);
          assert.deepEqual(changed.preflight.work.expected,expected);
          assert.deepEqual(changed.preflight.work.scopeChange.removed,removed);
          assert.deepEqual(changed.preflight.work.scopeChange.added,added);
          await record(name+'-预检',{changed,stale:{url:previousUrl,zip:oldZip.status(),file:oldFile.status()}});
          await page.reload();
          await page.locator('#process').waitFor();
          previous=await collect('/process',()=>page.locator('#process').click());
          await record(name+'-终检',previous);
          await save(name);
          if(name==='只读审核'){
            assert.equal(previous.preflight.work.readOnly,true);
            assert.deepEqual(previous.candidate.changes,[]);
            assert.ok(previous.audit.allowed.every(file=>!/(^filing-|^source-pdf$)/u.test(file.kind)));
          } else assert.ok(previous.audit.work.deliverables.every(item=>item.status==='经审核'));
        }
      }
    } else {
      assert.notDeepEqual([before.preflight.work.expected,before.preflight.work.mode],[expected,'draft']);
    }
    await page.close();
  }
} finally {
  clearTimeout(deadline);
  await browser?.close();
  if(server.exitCode===null && server.signalCode===null) {
    const exit=once(server,'exit');
    server.kill();
    await exit;
  }
}
