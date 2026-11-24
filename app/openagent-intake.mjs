import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

const origin = 'http://127.0.0.1:8091/api/cases';
const webchatInputs = ['/oasn/media/inbound', '/root/.openclaw/media/inbound'];
const allowedInputs = ['/oasn/in/files', '/oasn/inputFiles', ...webchatInputs];
const maxBytes = 48 * 1024 * 1024;
const casePattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u;
const uuidSuffix = /---[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?=\.[^.]+$)/iu;
const maskedAttachment = /^(.+---[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{2,4})\*\*\*(\.[^.]+)$/iu;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function attachmentPath(path) {
  const directory = dirname(path);
  const masked = maskedAttachment.exec(basename(path));
  if (masked && webchatInputs.includes(directory)) {
    // WebChat can mask the tail of the per-upload ID in the message metadata.
    const [, prefix, extension] = masked;
    const uploadIdOffset = prefix.lastIndexOf('---');
    const matches = (await readdir(directory)).filter(name =>
      name.startsWith(prefix) && name.endsWith(extension) && uuidSuffix.exec(name)?.index === uploadIdOffset);
    if (matches.length !== 1) throw Error('平台附件路径无法唯一对应，请重新上传该件。');
    return join(directory,matches[0]);
  }
  return path;
}

async function uploads(paths, request) {
  const form = new FormData();
  form.set('request',request);
  const roots = (await Promise.all(allowedInputs.map(root=>realpath(root).catch(()=>null)))).filter(Boolean);
  let total = 0;
  for (const path of new Set(paths)) {
    if (typeof path !== 'string' || !allowedInputs.some(root=>path.startsWith(root+'/'))) {
      throw Error('附件须来自本轮平台收件。');
    }
    const file = await attachmentPath(path);
    const resolved = await realpath(file);
    if (!roots.some(root=>resolved.startsWith(root+'/'))) throw Error('附件路径无效。');
    const info = await stat(resolved);
    if (!info.isFile() || (total += info.size)>maxBytes) throw Error('请选择有效附件，合计最多 48 MiB。');
    const name = basename(file).replace(uuidSuffix,'');
    form.append('files',new Blob([await readFile(resolved)]),name);
    form.append('paths',name);
  }
  return form;
}

async function call(path='', options={}) {
  const response = await fetch(origin+path,{...options,signal:AbortSignal.timeout(165000)});
  if (!response.ok) {
    const error = await response.json().catch(()=>null);
    throw Error(error?.error || '工作台响应 '+response.status);
  }
  return response;
}

async function change(state, action, body, search='') {
  const headers = {'x-case-revision':String(state.revision)};
  if (typeof body === 'string') headers['content-type'] = 'application/json';
  return (await call(`/${state.id}/${action}${search}`,{method:'POST',headers,body})).json();
}

function overview(state) {
  const check = state.preflight?.versionCheck;
  const work = state.preflight?.work;
  const missing = [];
  if (!state.preflight) missing.push(state.lastError || '请打开工作台检查预检。');
  if (work?.needsConfirmation || (work?.mode !== 'review' && !work?.expected?.length)) missing.push('请确认应交材料。');
  if (work?.mode === 'draft' && !state.target?.version) missing.push('请确认目标版本。');
  if (check?.blocking) missing.push(...(check.questions ?? []).map(({title,detail})=>[title,detail].filter(Boolean).join('，')));
  return {caseId:state.id,revision:state.revision,method:state.method,policy:state.policy,stage:state.stage,
    softwareName:state.softwareName,version:state.target?.version,expected:work?.expected,missing,
    versionBlocked:!!check?.blocking,files:state.containers?.map(({path,hash})=>({path,sha256:hash})),entries:state.entries?.length};
}

async function run(input) {
  const {phase,caseId,revision,paths=[],request='',version,softwareName} = input;
  if (!Array.isArray(paths) || paths.length>550 || typeof request !== 'string' || request.length>2000 ||
      (caseId && !casePattern.test(caseId))) throw Error('收件参数无效。');
  let state = caseId && await (await call('/'+caseId)).json();
  if (phase === 'revise' && (!state || !request.trim())) throw Error('请提供本对话的案卷编号和本轮修改原话。');
  const start = phase === 'start' || phase === 'prepare';
  if (start || phase === 'revise') {
    if (!state && !paths.length) return {missing:['请上传本次软件的源码 ZIP 或发行包。']};
    const form = paths.length && await uploads(paths,request);
    if (!state) state = await (await call('',{method:'POST',body:form})).json();
    else {
      if (form) state = await change(state,'intake',form);
      if (request && request !== state.request) state = await change(state,'request',JSON.stringify({request}));
    }
    const target = new URLSearchParams();
    if (version && 'V'+String(version).replace(/^v/i,'') !== state.target?.version) target.set('version',version);
    if (softwareName && softwareName !== state.softwareName) target.set('softwareName',softwareName);
    if (target.size) state = await change(state,'target',undefined,'?'+target);
    if (phase === 'prepare') return overview(state);
  }
  if (!start && phase !== 'revise' && (phase !== 'process' || !state || revision !== state.revision || paths.length)) {
    throw Error('请使用本轮预检的案卷编号和修订号。');
  }
  const summary = overview(state);
  if (summary.missing.length || summary.versionBlocked) return summary;
  if (!state.audit?.valid) state = await change(state,'process');
  const audit = state.audit;
  if (!audit?.valid) throw Error('当前终检没有有效取件回执。');
  const root = join('/oasn/out','软著审阅',state.id,audit.id);
  await mkdir(root,{recursive:true,mode:0o700});
  const selected = audit.work.deliverables.flatMap(item=>item.files.map(file=>file.path));
  const files = audit.allowed.flatMap((file,index)=>selected.includes('经审核材料/'+file.path) && /\.(docx|pdf)$/iu.test(file.path) ? [{...file,index}] : []);
  const result = await Promise.all([{path:'软著材料－内部审阅包.zip',index:'bundle'},...files].map(async file=>{
    const response = await call(`/${state.id}/download/${audit.id}/${file.index}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = sha256(bytes);
    if (file.hash && hash !== file.hash) throw Error('终件指纹不一致。');
    const path = join(root,basename(file.path));
    await writeFile(path,bytes,{mode:0o600});
    return {path,sha256:hash};
  }));
  return {...overview(state),receipt:audit.id,quality:audit.quality,deliverables:audit.work.deliverables,
    pending:audit.submission.items.filter(item=>item.status!=='已确认').map(({title,status})=>({title,status})),downloads:result};
}

try {
  const input = JSON.parse(await readFile(process.argv[2],'utf8'));
  console.log(JSON.stringify(await run(input)));
} catch (error) {
  console.error(JSON.stringify({error:error.message}));
  process.exitCode = 1;
}
