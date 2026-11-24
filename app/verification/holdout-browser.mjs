import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { chromium, chrome, JSZip } from '../runtime.mjs';

const [targetPath, output] = process.argv.slice(2);
const origin = process.env.SOFTCERT_ORIGIN;
if (!targetPath || !output || !origin) {
  throw new Error('请设置 SOFTCERT_ORIGIN，传入冻结上传 JSON 和独立的证据目录。');
}
const path = resolve(targetPath);
const spec = JSON.parse(await readFile(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const inputs = await Promise.all(spec.files.map(async item => {
  const filename = resolve(dirname(path), item.path);
  const data = await readFile(filename);
  if (hash(data) !== item.sha256) throw new Error('Frozen input changed: ' + item.path);
  return { name: item.name ?? basename(filename), sha256: item.sha256, bytes: data.length, data };
}));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ acceptDownloads: true });
page.setDefaultTimeout(20000);
const evidence = {
  origin, target: spec.version, request: spec.request,
  uploads: inputs.map(({data, ...rest}) => rest),
  stages: [], downloads: [], errors: [],
};
page.on('pageerror', error => evidence.errors.push(error.message));
const save = name => writeFile(join(output, name), JSON.stringify(evidence, null, 2) + '\n');
const screenshot = name => page.screenshot({ path: join(output, name), animations:'disabled' });
const button = name => page.getByRole('button', { name, exact: true });
async function submit(name, route, action) {
  const responsePromise = page.waitForResponse(item => item.request().method() === 'POST' &&
    new URL(item.url()).pathname.endsWith(route), { timeout: 480000 });
  const [response] = await Promise.all([responsePromise, action ? action() : button(name).click()]);
  const stage = { name, url: response.url(), http: response.status(), payload: await response.json() };
  evidence.stages.push(stage);
  await save('网页回执.json');
  await page.waitForFunction(() => !document.querySelector('#upload-button').disabled, null, { timeout: 30000 });
  stage.notice = await page.locator('#notice').innerText();
  stage.visibleNotice = await page.locator('#notice').isVisible();
  await save('网页回执.json');
  return response.ok();
}
async function download(link, filename) {
  const href = await link.getAttribute('href');
  const [event] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), link.click()]);
  const error = await event.failure();
  if (error) throw new Error('Download failed: ' + error);
  await event.saveAs(join(output, filename));
  const data = await readFile(join(output, filename));
  evidence.downloads.push({ filename, original: event.suggestedFilename(), href, url: event.url(), bytes: data.length, sha256: hash(data) });
  await save('网页回执.json');
  return data;
}
try {
  await page.goto(origin);
  await page.locator('#request').fill(spec.request);
  const attachments = inputs.map(item => ({name:item.name,
    mimeType:item.name.endsWith('.pdf') ? 'application/pdf' : item.name.endsWith('.zip') ? 'application/zip' : 'text/plain',
    buffer:item.data}));
  await page.locator('#files').setInputFiles(attachments);
  if (await submit('开始预检','/api/cases')) {
    await screenshot('网页预检.png');
    if (spec.version && await page.getByLabel('本次软件版本').isVisible()) {
      await page.getByLabel('本次软件版本').fill(spec.version);
      if (spec.snapshot) await page.getByLabel('确认采用此固定源码快照').check();
      await submit('确认版本','/target');
      await screenshot('网页确认版本.png');
    }
    const processButton = page.locator('#process');
    if (await processButton.isVisible() && await processButton.isEnabled()) {
      const label = await processButton.innerText();
      await submit(label,'/process', () => processButton.click());
    }
    evidence.caseUrl = page.url();
    const links = page.locator('a[href*="/download/"]');
    evidence.links = await links.evaluateAll(nodes => nodes.map(a=>({ text:a.innerText || a.textContent, href:a.getAttribute('href')})));
    const bundle = page.getByRole('link',{name:'下载内部审阅包', exact:true});
    if (await bundle.isVisible()) {
      const contents = await JSZip.loadAsync(await download(bundle,'实际网页-内部审阅包.zip'));
      evidence.zipEntries = Object.keys(contents.files).filter(name=>!contents.files[name].dir);
      const receipt = contents.file('审核回执.json');
      evidence.zipReceipt = receipt ? JSON.parse(await receipt.async('string')) : null;
      await download(page.getByRole('link',{name:'下载提交准备度核对',exact:true}),'实际网页-提交准备度.md');
      const list = page.locator('summary').filter({hasText:/^逐件下载/});
      if (await list.count()) await list.click();
      const pdfs = evidence.links.filter(item=>/\.pdf$/iu.test(item.text));
      for (const [index,item] of pdfs.entries()) {
        await download(page.getByRole('link',{name:item.text,exact:true}),'实际网页-'+String(index+1).padStart(2,'0')+'-'+basename(item.text));
      }
    }
  }
} catch (error) {
  evidence.errors.push(error.stack ?? error.message);
  process.exitCode = 1;
} finally {
  await screenshot('网页最终.png').catch(error=>evidence.errors.push(error.message));
  evidence.finalStage = await page.locator('#stage').innerText().catch(()=>null);
  evidence.finalNotice = await page.locator('#notice').innerText().catch(()=>null);
  await save('网页回执.json');
  const state = evidence.stages.at(-1)?.payload;
  if (!evidence.zipReceipt || evidence.errors.length) process.exitCode = 1;
  console.log(JSON.stringify({ case:state?.id, method:state?.method, stages:evidence.stages.map(s=>[s.name,s.http]), notice:evidence.finalNotice,
    downloads:evidence.downloads.map(item=>item.filename), errors:evidence.errors.map(item=>item.split('\n')[0]) }));
  await browser.close();
}
