import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {chromium, chrome, JSZip, archive} from '../runtime.mjs';
import {digest} from '../files.mjs';

const [application, output, mode] = process.argv.slice(2);
assert.ok(application && output && ['parent','candidate'].includes(mode));
const directory = resolve(output);
const data = join(directory,'隔离案卷');
await mkdir(data,{recursive:true});
const server = spawn(join(resolve(application),'app/start.sh'), [], {
  env:{...process.env,SOFTCERT_PORT:'0',SOFTCERT_DATA:data}, stdio:['ignore','pipe','inherit'],
});
const timeout = setTimeout(()=>server.kill(),15000);
let browser;
try {
  const [url]=await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Server exited');})]);
  clearTimeout(timeout);
  const origin=url.toString().trim();
  browser=await chromium.launch({executablePath:chrome,headless:true});
  const page=await browser.newPage();
  const collect=async (suffix,action)=>{
    const received=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname.endsWith(suffix),{timeout:240000});
    await action();
    const response=await received;
    assert.equal(response.status(),200,await response.text());
    await page.locator('#notice').waitFor({state:'hidden',timeout:240000});
    return response.json();
  };
  const save=async (name,result)=>{
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'下载内部审阅包',exact:true}).click()]);
    const path=join(directory,name+'.zip');
    await download.saveAs(path);
    const bytes=await readFile(path);
    const zip=await JSZip.loadAsync(bytes);
    assert.equal(JSON.parse(await zip.file('审核回执.json').async('string')).id,result.audit.id);
    await writeFile(join(directory,name+'.json'),JSON.stringify({origin,digest:digest(bytes),result},null,2)+'\n');
    return zip;
  };
  const source=join(archive,'04 模拟样例与网页原型/网页产物/Hollow－脱敏原始材料.zip');
  const supplement=join(archive,'03 Hollow 历史公开案卷/真实软著案卷复验/设计说明书（整理版）.pdf');
  const processCase=()=>collect('/process',()=>page.locator('#process').click());
  const stale=async previous=>{
    const url=origin+'/api/cases/'+previous.id+'/download/'+previous.audit.id;
    const codes=await Promise.all(['/bundle','/0'].map(async slot=>(await page.request.get(url+slot)).status()));
    assert.deepEqual(codes,[409,409]);
    return {receipt:previous.audit.id,bundle:codes[0],single:codes[1]};
  };
  const resume = process.env.SOFTCERT_HOLLOW_RESUME;
  if (resume) {
    const {before}=JSON.parse(await readFile(join(directory,'原件预检.json'),'utf8'));
    const {result:first}=JSON.parse(await readFile(join(directory,'原案实际下载.json'),'utf8'));
    const {result:registered}=JSON.parse(await readFile(join(directory,'补正登记后实际下载.json'),'utf8'));
    await page.goto(origin+'/?case='+before.id);
    await page.getByRole('heading',{name:'补正事项',exact:true}).waitFor();
    await finish(before,first,registered);
  } else {
  await page.goto(origin);
  await page.locator('#request').fill('我们要给这个版本办软著，源码和旧手册都在包里。能确认的请直接改到 Word 副本里，给我审一下原件和改动。还要我补什么，列给我。');
  await page.locator('#files').setInputFiles([source]);
  const before=await collect('/api/cases',()=>page.getByRole('button',{name:'开始预检',exact:true}).click());
  await writeFile(join(directory,'原件预检.json'),JSON.stringify({origin,before},null,2)+'\n');
  const first=await processCase();
  await save('原案实际下载',first);
  assert.ok(first.preflight.historical);
  assert.ok(first.audit.allowed.some(item=>item.kind==='historical-source-original'));
  if(mode==='parent'){
    assert.equal(first.correction,undefined);
    assert.equal(await page.getByRole('heading',{name:'补正事项',exact:true}).count(),0);
  } else {
    await page.getByText('登记通知事项',{exact:true}).click();
    await page.getByLabel('通知页码',{exact:true}).fill('1');
    await page.getByLabel('通知要求',{exact:true}).fill('说明截图中的院校、所引研究与本软件的关系，并明确权利归属。');
    await page.getByLabel('负责补件的人',{exact:true}).fill('申请人及文档整理人');
    await page.getByLabel('说明书',{exact:true}).check();
    await page.getByLabel('权利证明',{exact:true}).check();
    const registered=await collect('/correction',()=>page.getByRole('button',{name:'保存补正事项',exact:true}).click());
    assert.equal(registered.audit.corrections[0].status,'待补答复或证据');
    await save('补正登记后实际下载',registered);
    await finish(before,first,registered);
  }
  }
  async function finish(before,first,registered){
    const firstStale=await stale(first);
    let afterIntake;
    if (resume) afterIntake=await (await page.request.get(origin+'/api/cases/'+before.id)).json();
    else {
      await page.locator('#files').setInputFiles([supplement]);
      afterIntake=await collect('/intake',()=>page.getByRole('button',{name:'保存材料并预检',exact:true}).click());
    }
    const supplementStale=await stale(registered);
    assert.ok(before.entries.every(file=>afterIntake.entries.some(next=>next.path===file.path && next.hash===file.hash)));
    await page.reload();
    await page.getByRole('heading',{name:'补正事项',exact:true}).waitFor();
    await page.getByText('更新此项',{exact:true}).click();
    const added=afterIntake.entries.find(file=>!before.entries.some(existing=>existing.path===file.path));
    const editor=page.getByText('更新此项',{exact:true}).locator('..');
    await editor.locator('select[multiple]').selectOption(added.path);
    await collect('/correction',()=>editor.getByRole('button',{name:'保存补正事项',exact:true}).click());
    const verified=await processCase();
    const bundle=await save('补件复验实际下载',verified);
    assert.ok(verified.audit.allowed.some(item=>item.kind==='historical-reviewed-manual'));
    assert.equal(verified.audit.corrections[0].status,'待逐项复核');
    assert.equal(verified.audit.filingReady,false);
    assert.equal(verified.audit.externalStatus,'无受理或登记回执');
    assert.equal(verified.audit.corrections[0].links[0].hash,added.hash);
    assert.match(await bundle.file('补正事项对照.md').async('string'),/第 1 页/u);
    await writeFile(join(directory,'旧取件结果.json'),JSON.stringify([firstStale,supplementStale],null,2)+'\n');
    await page.screenshot({path:join(directory,'补件复验.png'),fullPage:true});
  }
} finally {
  clearTimeout(timeout);
  await browser?.close();
  if(server.exitCode===null && server.signalCode===null) {
    const exit=once(server,'exit');
    server.kill();
    await exit;
  }
}
