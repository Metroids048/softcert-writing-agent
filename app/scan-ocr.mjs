import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./scan-ocr.swift', import.meta.url));
const cache = new Map();
let queue = Promise.resolve();

async function recognize(bytes, pages) {
  const process = spawn('/usr/bin/swift',[script,...pages.map(String)],
    {stdio:['pipe','pipe','ignore'],timeout:90000,killSignal:'SIGKILL'});
  process.stdin.on('error',()=>{});
  process.stdin.end(bytes);
  const chunks = [];
  const result = await new Promise(resolve => {
    process.stdout.on('data',chunk=>chunks.push(chunk));
    process.once('error',()=>resolve(null));
    process.once('close',code=>resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
  });
  return result === null ? null : JSON.parse(result);
}

function recognizeBlock(bytes, hash, pages) {
  const key = hash+':'+pages.join(',');
  if (!cache.has(key)) {
    const task = queue.then(()=>recognize(bytes,pages)).catch(()=>null);
    queue = task.then(()=>{});
    cache.set(key,task);
    task.then(result=>{
      if (result === null) cache.delete(key);
      else if (cache.size > 40) cache.delete(cache.keys().next().value);
    });
  }
  return cache.get(key);
}

export async function recognizeScan(bytes, hash, pages) {
  const blocks = [];
  for (let start=0; start<pages.length; start+=24) {
    blocks.push(recognizeBlock(bytes,hash,pages.slice(start,start+24)));
  }
  const results = await Promise.all(blocks);
  return results.every(result=>result === null) ? null : results.flatMap(result=>result ?? []);
}

export function scanTranscript(path, ocr) {
  return Buffer.from([
    '本机 OCR 识别文本（仅供检索和人工校对，页面以原 PDF 为准）',
    '原件：'+path, '原件 SHA-256：'+ocr.hash, '',
    ...ocr.pages.flatMap(({page,lines,literalReadbacks})=>['【原 PDF 第 '+page+' 页】',...lines,
      ...(literalReadbacks?.length ? ['', '同页局部 OCR 复读（保留首遍结果，请对照原页）：',
        ...literalReadbacks.map(({line,original,alternate})=>'第 '+line+' 条：首遍 '+original+'，复读 '+alternate+'。')] : []), '']),
    ...(ocr.unresolved.length ? ['仍需人工核读：第 '+ocr.unresolved.join('、')+' 页。',''] : []),
  ].join('\n'));
}
