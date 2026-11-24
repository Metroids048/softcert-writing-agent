import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium,chrome,root} from '../runtime.mjs';
import {digest} from '../files.mjs';

const [database,receipts,destination] = process.argv.slice(2).map(path=>resolve(path));
const frozen = join(root,'运行证据/v0.3.21-中文新案双测-2026-11-23/亲戚关系计算器');
const input = JSON.parse(await readFile(join(frozen,'冻结上传.json'),'utf8'));
const before = JSON.parse(await readFile(join(receipts,'亲戚关系计算器/工作台回执.json'),'utf8'));
await mkdir(destination,{recursive:true});
const trace = [];
const browser = await chromium.launch({executablePath:chrome,headless:true});
const page=await browser.newPage();
let server,origin;
async function start(port='0'){
  server=spawn(join(root,'app/start.sh'),[],{
    env:{...process.env,SOFTCERT_PORT:port,SOFTCERT_DATA:database},stdio:['ignore','pipe','inherit'],
  });
  const [url]=await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Server exited');})]);
  return url.toString().trim();
}
async function stop(){
  if(server?.exitCode===null && server.signalCode===null) {
    const done=once(server,'exit');server.kill();await done;
  }
}
const route='/api/cases/'+before.caseId;
const collect=async (suffix, click, status=200)=>{
  const received=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname===route+suffix,{timeout:240000});
  await click();
  const response=await received;
  assert.equal(response.status(),status,(await response.text()).slice(0,300));
  await page.locator('#notice').waitFor({state:status===200?'hidden':'visible',timeout:240000});
  return response.json();
};
const read=async()=> (await page.request.get(origin+route)).json();
const codes=async auditId=>Promise.all(['/bundle','/0'].map(async slot=>
  (await page.request.get(origin+route+'/download/'+auditId+slot)).status()));
const record=async (event,data)=>{
  trace.push({event,...data});
  await writeFile(join(destination,'真实入口恢复回执.json'),JSON.stringify({id:before.caseId,origin,trace},null,2)+'\n');
};
try {
  origin=await start();
  await page.goto(origin+'/?case='+before.caseId);
  await page.getByRole('heading',{name:'终件复验',exact:true}).waitFor();
  const initial=await read();
  assert.equal(initial.policy,before.policy);
  assert.equal(initial.audit.id,before.audit.id);
  assert.deepEqual(await codes(initial.audit.id),[200,200]);
  const suspect=initial.entries.find(file=>file.path.endsWith('.softcert-run.json'));
  const blob=join(database,'blobs',suspect.hash);
  await rename(blob,blob+'.recovery-backup');
  try {
    const failed=await codes(initial.audit.id);
    assert.deepEqual(failed,[409,409]);
    const attempt=await collect('/process',()=>page.locator('#process').click());
    assert.equal(attempt.audit.runtimeEvidence.matched,0);
    await record('启动恢复后原实操文件不可读',{unreadable:suspect.path,previous:initial.audit.id,failed,
      pendingAudit:attempt.audit.id,matching:attempt.audit.runtimeEvidence.matched,issues:attempt.audit.issues,
      deliverables:attempt.audit.work.deliverables,allowed:attempt.audit.allowed.map(file=>file.path)});
    assert.ok(!attempt.audit.allowed.some(file=>['source-pdf','filing-manual'].includes(file.kind)));
    assert.equal(attempt.audit.work.deliverables.find(item=>item.key==='source').status,'待补');
  } finally {
    await rename(blob+'.recovery-backup',blob);
  }
  const retried=await collect('/process',()=>page.locator('#process').click());
  assert.equal(retried.audit.runtimeEvidence.matched,4);
  const staleRetry=await codes(initial.audit.id);
  assert.deepEqual(staleRetry,[409,409]);
  await record('原附件恢复后重试',{audit:retried.audit.id,stale:staleRetry,matching:retried.audit.runtimeEvidence.matched});
  await page.locator('#version').fill('V1.2.7');
  const mismatched=await collect('/target',()=>page.getByRole('button',{name:'确认版本',exact:true}).click());
  assert.equal(mismatched.preflight.versionCheck.blocking,true);
  const blocked=await collect('/process',()=>page.locator('#process').click());
  assert.ok(!blocked.audit.allowed.some(file=>file.kind==='source-pdf' || file.kind==='filing-manual'));
  const staleOnVersion=await codes(retried.audit.id);
  assert.deepEqual(staleOnVersion,[409,409]);
  await record('改成与原发布包冲突的历史目标版本',{target:mismatched.target,
    audit:blocked.audit.id,stale:staleOnVersion,questions:blocked.preflight.versionCheck.questions});
  await page.locator('#version').fill(input.version);
  await collect('/target',()=>page.getByRole('button',{name:'确认版本',exact:true}).click());
  const restored=await collect('/process',()=>page.locator('#process').click());
  await page.getByText(/^原件清单/).click();
  const emptied=await collect('/withdraw',()=>page.getByRole('button',{name:'撤回 '+suspect.path,exact:true}).click());
  assert.equal(emptied.target.version,input.version);
  assert.ok(!emptied.entries.some(file=>file.path===suspect.path));
  const staleWithdrawal=await codes(restored.audit.id);
  assert.deepEqual(staleWithdrawal,[409,409]);
  const missing=await collect('/process',()=>page.locator('#process').click());
  assert.equal(missing.audit.runtimeEvidence.matched,0);
  await record('撤回同版操作记录',{stale:staleWithdrawal,shown:missing.audit.runtimeEvidence,
    issues:missing.audit.issues,deliverables:missing.audit.work.deliverables,allowed:missing.audit.allowed.map(file=>file.path)});
  assert.ok(!missing.audit.allowed.some(file=>['source-pdf','filing-manual'].includes(file.kind)));
  assert.equal(missing.audit.work.deliverables.find(item=>item.key==='source').status,'待补');
  const upload=input.files.find(file=>file.path.includes('实操'));
  const path=join(frozen,upload.path);
  assert.equal(digest(await readFile(path)),upload.sha256);
  await page.locator('#files').setInputFiles([path]);
  const intake=await collect('/intake',()=>page.getByRole('button',{name:'保存材料并预检',exact:true}).click());
  assert.ok(intake.entries.some(file=>file.path===suspect.path && file.hash===suspect.hash));
  const staleReplacement=await codes(missing.audit.id);
  assert.deepEqual(staleReplacement,[409,409]);
  const final=await collect('/process',()=>page.locator('#process').click());
  assert.equal(final.audit.runtimeEvidence.matched,4);
  assert.deepEqual(final.audit.sourceVolumes,['front_30','back_30']);
  const port=new URL(origin).port;
  await stop();
  assert.equal(await start(port),origin);
  await page.reload();
  await page.getByRole('heading',{name:'终件复验',exact:true}).waitFor();
  const after=await read();
  assert.equal(after.audit.id,final.audit.id);
  assert.deepEqual(await codes(after.audit.id),[200,200]);
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'下载内部审阅包',exact:true}).click()]);
  const saved=join(destination,'重启后实际下载.zip');
  await download.saveAs(saved);
  await record('归档原证据补回并重启',{stale:staleReplacement,policy:after.policy,receipt:after.audit.id,
    download:digest(await readFile(saved)),matching:after.audit.runtimeEvidence.matched});
} finally {
  await browser.close();
  await stop();
}
