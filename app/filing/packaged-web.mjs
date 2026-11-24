import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../files.mjs';
import { JSZip, root } from '../runtime.mjs';
import { browserResourceProofs, normalizedVersion, runtimeVersionInputs } from '../runtime-evidence.mjs';

const configPath = join(root,'app/filing/packaged-web.json');
const profiles = JSON.parse(readFileSync(configPath,'utf8'));
const evidencePrefix = '运行证据/';
const evidenceDirectory = process.env.SOFTCERT_CASE_EVIDENCE || join(root,'运行证据');
const externalAsset = file => file.startsWith(evidencePrefix);
const assetPath = file => externalAsset(file) ? join(evidenceDirectory,file.slice(evidencePrefix.length)) : join(root,file);
export const packagedWebAssets = [configPath, join(root,'app/filing/packaged-web.mjs'),
  ...Object.values(profiles).flatMap(profile=>[...profile.replay,...profile.supplements ?? []]
    .filter(({file})=>file && (!externalAsset(file) || existsSync(assetPath(file))))
    .map(({file})=>assetPath(file)))];

function verifiedBytes(file, read) {
  const bytes = read(file);
  if (digest(bytes) !== file.sha256) throw new Error('运行资源与固定指纹不符：'+file.path);
  return bytes;
}

function currentBrowserProofs(state, read, archiveSha256, softwareName, version, commit) {
  return browserResourceProofs(state.entries,read,{archiveSha256,
    names:[softwareName,state.softwareName].filter(Boolean),version,commit});
}

function staticMembers(state, archiveSha256, prefix) {
  return new Map(state.entries.filter(file=>file.container?.hash === archiveSha256 && file.path.startsWith(prefix))
    .map(file=>['/'+file.path.slice(prefix.length),file]));
}

function staticBrowserProof(state, read, {archiveSha256,softwareName,version,commit,members,expected}) {
  return currentBrowserProofs(state,read,archiveSha256,softwareName,version,commit).find(proof=>{
    if (expected && (proof.sha256 !== expected.sha256 || proof.path !== expected.path)) return false;
    const urls = Object.keys(proof.served);
    return urls.some(url=>/\.html?$/iu.test(url)) && urls.every(url=>
      /\.(?:html?|css|m?js)$/iu.test(url) && proof.served[url] === members.get(url)?.hash);
  });
}

export function packagedWebProofCurrent(state, read) {
  const selection = state.preflight?.packaged;
  const binding = selection?.web ?? selection?.sourcePending;
  const archiveSha256 = binding?.archiveSha256;
  if (!archiveSha256) return true;
  const {softwareName,version} = selection;
  if (binding.commit && binding.prefix) {
    const members = staticMembers(state,archiveSha256,binding.prefix);
    const recorded = staticBrowserProof(state,read,{archiveSha256,softwareName,version,commit:binding.commit,
      members,expected:selection.web?.proof});
    return Boolean(recorded) === Boolean(selection.web);
  }
  const expectedProof = selection.web?.proof;
  const recorded = currentBrowserProofs(state,read,archiveSha256,softwareName,version)
    .some(item=>item.sha256 === (expectedProof?.sha256 ?? profiles[archiveSha256]?.proofSha256) &&
      (!expectedProof?.path || item.path === expectedProof.path));
  return recorded === Boolean(selection.web);
}

const nameKey = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');

export async function staticWebRelease(state, read) {
  if (!state.target?.confirmedAt) return null;
  const probes = runtimeVersionInputs(state.entries,read).filter(probe=>probe.commitProbe);
  const manifests = state.entries.filter(file=>/^[^/]+-[a-f0-9]{40}\/README\.md$/i.test(file.path) &&
    probes.some(probe=>probe.archiveSha256 === file.container?.hash));
  if (manifests.length !== 1) return null;
  const [manifest] = manifests;
  const archive = state.containers.find(file=>file.hash === manifest.container.hash);
  if (!archive || profiles[archive.hash]) return null;
  const prefix = manifest.path.slice(0,manifest.path.indexOf('/')+1);
  const commit = prefix.slice(-41,-1);
  const zip = await JSZip.loadAsync(read(archive));
  if (zip.comment !== commit) return null;
  const readme = read(manifest).toString('utf8');
  const heading = /^#\s+(.{1,100}?)\s+(v\d+(?:\.\d+){1,3})\s*$/iu.exec(readme.split(/\r?\n/u,1)[0]);
  if (!heading) return null;
  const name = heading[1].replace(/^[^\p{L}\p{N}]+/u,'');
  if (!name || (state.softwareName && nameKey(state.softwareName) !== nameKey(name))) return null;
  const version = normalizedVersion(heading[2]);
  const members = staticMembers(state,archive.hash,prefix);
  const proof = staticBrowserProof(state,read,{archiveSha256:archive.hash,softwareName:name,version,commit,members});
  return {path:manifest.path,sha256:manifest.hash,name,version,commit,prefix,archiveSha256:archive.hash,
    location:'README 首行发布名称与版本；ZIP 注释及归档根路径对应提交 '+commit,archive,proof,members,
    opensLocally:/双击.{0,12}(?:即可|直接).{0,8}(?:使用|打开|运行)/u.test(readme)};
}

export function resolveStaticWeb(release) {
  const {archive,archiveSha256,commit,prefix,members,proof} = release;
  if (!proof) return {html:[],sourcePending:{archiveSha256,commit,prefix,
    detail:'请补本版归档提交记录和浏览器实际响应文件指纹，再确认静态网页的交存范围。'}};
  const decisions = Object.entries(proof.served).map(([url,sha256])=>
    ({url,path:url.slice(1),decision:'纳入',sha256,basis:'实际响应与此提交归档成员逐字节相同。'}));
  const entrypoints = decisions.filter(row=>/\.html?$/iu.test(row.path));
  const html = entrypoints.map(row=>members.get(row.url).path);
  const archiveName = archive.path.split('/').at(-1);
  const replay = [{...archive,path:'可复走原件/'+archiveName,source:'本案上传的同版源码归档'}];
  const launch = release.opensLocally ? [
    '在下载包「可复走原件」找到 '+archiveName+'，完整解压到一个普通目录。进入解压后的项目目录，保留文件名和上游的目录结构。',
    '打开原件 README.md。首行所列 '+release.name+' '+release.version+' 是本手册的版次；解压目录对应源码提交 '+commit+'。',
    '按作者文档直接从解压目录打开 HTML。'+(proof.browser ? '同版实操记录的浏览器版本为 '+proof.browser+'。' : '')+
      '优先选用已完成实操的浏览器。可在浏览器的「打开文件」里定位 HTML，或在文件管理器中选择用浏览器打开。',
    ...entrypoints.map(row=>'入口文件 '+row.path+' 位于项目目录中。用浏览器打开该文件，按下文对应实操步骤核对首次就绪界面和操作结果。'),
    '涉及导出时，从浏览器的下载记录打开刚生成的文件，保留上游原件。复核保存后的数据时，回到完成操作的同一浏览器和页面。',
    '取件包「源码行号映射.json」的 runtime_resource_scope 字段列出响应路径、归档成员和 SHA-256。若文件来源不明，从同包原件重新解压再操作。按下文的动作、结果和图号对照同版截图。',
  ] : [];
  return {html,web:{archiveSha256,commit,prefix,proof:{path:proof.path,sha256:proof.sha256},decisions,supplements:[],replay,launch}};
}

export function resolvePackagedWeb(state, blobs, manifest, prefix, softwareName, version) {
  const archive = manifest?.container;
  if (!archive) return null;
  const proofs = currentBrowserProofs(state,blobs.read,archive.hash,softwareName,version);
  const responseMatches = (file,path) => proofs.some(proof=>proof.served[path] === file.hash);
  const html = state.entries.filter(file=>file.container?.hash === archive.hash && file.path.startsWith(prefix) &&
    /\.html?$/iu.test(file.path) && responseMatches(file,'/'+file.path.slice(prefix.length))).map(file=>file.path);
  const profile = profiles[archive.hash];
  const proof = profile && proofs.find(item=>item.sha256 === profile.proofSha256);
  if (!proof) return {html,web:null,...(profile && {sourcePending:{archiveSha256:archive.hash,
    detail:'本版拟交存范围依赖同版浏览器记录。请恢复已核对的原实操记录及截图，再确认入口、运行资源和卷别。'}})};
  const missing = [...profile.replay,...profile.supplements ?? []].find(({file})=>
    file && externalAsset(file) && !existsSync(assetPath(file)));
  if (missing) return {html,web:null,sourcePending:{archiveSha256:archive.hash,
    detail:'缺少同版可复走原件：'+missing.name+'。请恢复固定发行包后重新预检。'}};
  const {launch} = profile;
  const decisions = profile.decisions.map(row=>{
    if (!row.basisFile) return row;
    const path = prefix+row.basisFile.path;
    const original = state.entries.find(file=>file.path === path && file.container?.hash === archive.hash);
    if (!original) throw new Error('缺少交存范围的归档依据：'+path);
    verifiedBytes({...row.basisFile,path},()=>blobs.read(original));
    return {...row,basisFile:{...row.basisFile,path}};
  });
  if (decisions.some(row=>row.sha256 !== (proof.served[row.url] ?? null)) ||
      Object.keys(proof.served).some(url=>!decisions.some(row=>row.url === url))) {
    throw new Error('实际运行资源与已核对的范围清单不一致。');
  }
  const supplements = (profile.supplements ?? []).map(item=>{
    const path = prefix+item.path;
    if (state.entries.some(file=>file.path === path) || proof.served[item.url] !== item.sha256) {
      throw new Error('复核补充源码的路径或实操指纹：'+path);
    }
    const bytes = verifiedBytes({...item,path},()=>readFileSync(assetPath(item.file)));
    return {path,...blobs.put(bytes),archiveSha256:archive.hash,origin:item.origin};
  });
  const replay = profile.replay.map(item=>{
    const path = '可复走原件/'+item.name;
    const bytes = verifiedBytes({...item,path},()=>item.container ? blobs.read(archive) : readFileSync(assetPath(item.file)));
    const source = item.file?.startsWith('app/') ? '同版实操装载页' : item.container ? '本案上传的源码归档' : '归档的同版公开发行包';
    return {path,...blobs.put(bytes),source};
  });
  return {html,web:{archiveSha256:archive.hash,proof:{path:proof.path,sha256:proof.sha256},
    decisions,supplements,replay,launch}};
}

export function launchLines(launch) {
  return launch?.length ? ['## 启动与准备','',...launch,''] : [];
}

export function launchMatches(launch, actual) {
  const plain = value => value.normalize('NFKC').replace(/[\s`]/gu,'');
  return !launch?.length || plain(actual).includes(plain('启动与准备'+launch.join('')));
}
