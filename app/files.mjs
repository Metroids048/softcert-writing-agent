import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JSZip } from './runtime.mjs';
import { safePath } from './intake-paths.mjs';

export const maxBytes = 48 * 1024 * 1024;
export const maxFiles = 320;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const stamp = value => digest(JSON.stringify(value));

export function blobStore(dir) {
  mkdirSync(dir, { recursive:true, mode:0o700 });
  return {
    put(bytes) {
      const hash = digest(bytes);
      const temporary = join(dir, hash + '.tmp');
      try {
        writeFileSync(temporary, bytes, { mode:0o600 });
        renameSync(temporary, join(dir, hash));
      } finally { rmSync(temporary, {force:true}); }
      return {hash, size:bytes.length};
    },
    read({hash, size}) {
      if (!/^[a-f\d]{64}$/.test(hash)) throw new Error('文件指纹格式无效。');
      const bytes = readFileSync(join(dir, hash));
      if (bytes.length !== size || digest(bytes) !== hash) throw new Error('文件指纹与案卷不一致。');
      return bytes;
    },
  };
}

function readEntry(entry, size) {
  return new Promise((resolve,reject)=>{
    const stream = entry.internalStream('uint8array');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    stream.on('data',chunk => {
      if (offset + chunk.length > size) {
        stream.pause();
        reject(new Error('ZIP 解包超出记录的长度。'));
      } else {
        bytes.set(chunk,offset);
        offset += chunk.length;
      }
    });
    stream.on('error',reject);
    stream.on('end',()=>offset === size ? resolve(bytes) : reject(new Error('ZIP 解包长度与记录不符。')));
    stream.resume();
  });
}

export async function expandUploads(uploads, blobs) {
  let length = 0;
  let scanned = 0;
  const entries = new Map();
  const containers = [];
  const skipped = [];
  const add = (path, bytes, container) => {
    const file = {path, ...blobs.put(bytes), ...(container && {container})};
    const prior = entries.get(path);
    if (prior && prior.hash !== file.hash) throw new Error('同一批有多个同路径文件，请先区分后再上传。');
    if (!prior) entries.set(path, file);
    else skipped.push({path, reason:'同路径同内容'});
  };
  for (const upload of uploads) {
    if (/\.zip$/i.test(upload.path)) {
      const zip = await JSZip.loadAsync(upload.bytes);
      const container = {path:upload.path, ...blobs.put(upload.bytes)};
      containers.push(container);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        if (++scanned > maxFiles) throw new Error('单次最多读取 '+maxFiles+' 件材料。');
        const path = safePath(entry.unsafeOriginalName ?? entry.name);
        if (!path || /\.zip$/i.test(path)) { skipped.push({path:entry.name, reason:'忽略不受支持的路径或嵌套压缩包'}); continue; }
        // JSZip normalizes empty ZIP entries to a STORE stream without a size record.
        const size = entry._data.uncompressedSize ?? (entry.options.compression === 'STORE' ? 0 : NaN);
        if (!Number.isSafeInteger(size) || size < 0 || (length += size) > maxBytes) throw new Error('解包后最多 48 MiB。');
        add(path, await readEntry(entry, size), container);
      }
    } else {
      if (++scanned > maxFiles || (length += upload.bytes.length) > maxBytes) throw new Error('单次最多 '+maxFiles+' 件、48 MiB。');
      add(upload.path, upload.bytes);
    }
  }
  if (!entries.size) throw new Error('未找到可接收的材料。');
  return {entries:[...entries.values()], containers, skipped};
}

export async function readUpload(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    if ((length += chunk.length) > maxBytes + 1024 * 1024) throw new Error('上传超过 48 MiB。');
    chunks.push(chunk);
  }
  const form = await new Response(Buffer.concat(chunks, length), {headers:{'Content-Type':req.headers['content-type']}}).formData();
  const files = form.getAll('files');
  const paths = form.getAll('paths');
  if (!files.length || files.length > maxFiles || files.length !== paths.length) throw new Error('请选择 1 至 '+maxFiles+' 件材料。');
  const uploads = [];
  let fileBytes = 0;
  for (let index=0; index<files.length; index++) {
    const file = files[index];
    const path = typeof paths[index] === 'string' && safePath(paths[index]);
    if (!path || typeof file.arrayBuffer !== 'function') throw new Error('附件路径无效。');
    if ((fileBytes += file.size) > maxBytes) throw new Error('上传超过 48 MiB。');
    uploads.push({path, bytes:Buffer.from(await file.arrayBuffer())});
  }
  return {uploads, request:String(form.get('request') ?? '').slice(0, 2000)};
}
