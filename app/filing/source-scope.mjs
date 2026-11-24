import { digest } from '../files.mjs';

export const sourceExtension = /\.(?:py|cs|java|kt|js|jsx|ts|tsx|vue|go|rs|c|h|cpp|cc|php|rb|swift|sql|cshtml|razor|html|sh|css|scss|sass|less|svelte)$/iu;

// Exclude only proven non-code resources, verified duplicate payloads, and explicitly attributed library blocks.
export function embeddedWebResources(files, read) {
  const byHash = new Map(files.map(file=>[file.hash,file.path]));
  const pngPrefix = Buffer.from('89504e470d0a1a0a','hex');
  return files.flatMap(file=>{
    const rows = read(file).toString('utf8').split(/\r\n|\n|\r/u);
    const ranges = [];
    const add = (first,last,kind,evidence) => ranges.push({path:file.path,sha256:file.hash,first,last,kind,evidence});
    let scriptStart = -1;
    for (const [index,raw] of rows.entries()) {
      const row = raw.trim();
      if (row === '<script>') scriptStart = index;
      if (row === '</script>' && scriptStart >= 0) {
        const script = rows.slice(scriptStart+1,index).map(line=>line.trim()).filter(Boolean);
        const header = script.slice(0,-1);
        const upstream = header.find(line=>/^\/\* GitHub : github\.com\/[\w.-]+\/[\w.-]+$/u.test(line));
        if (upstream && header.every(line=>line.startsWith('/*')) &&
            header.some(line=>line.startsWith('/* MIT license:')) &&
            script.at(-1)?.length > 3000 && /^(?:function |!function|\(function)/u.test(script.at(-1))) {
          add(scriptStart+1,index+1,'third-party-inline-script',upstream.slice('/* GitHub : '.length)+'；原头部标明 MIT。');
        }
        scriptStart = -1;
      }
      const icon = /^(?:<link rel=["']icon["'](?: type=["']image\/png["'])? href=|"favicon"\s*:\s*)["']data:image\/png;base64,([A-Za-z0-9+/=]+)["']\s*[,>]?$/iu.exec(row);
      if (icon) {
        const bytes = Buffer.from(icon[1],'base64');
        if (bytes.subarray(0,8).equals(pngPrefix) && bytes.toString('base64') === icon[1]) {
          add(index+1,index+1,'embedded-image','PNG 图标字节 SHA-256 '+digest(bytes));
        }
      }
      const template = /^(?:var|const|let)\s+\w+\s*=\s*\w+\(["']([A-Za-z0-9+/=]{1024,})["']\);$/u.exec(row);
      if (template) {
        const bytes = Buffer.from(template[1],'base64');
        const duplicate = byHash.get(digest(bytes));
        if (duplicate && duplicate !== file.path && bytes.toString('base64') === template[1]) {
          add(index+1,index+1,'duplicate-html-payload','解码字节与已纳入的 '+duplicate+' 完全相同。');
        }
      }
    }
    return ranges.sort((a,b)=>a.first-b.first);
  });
}

// Use evidence from the same uploaded archive before excluding a package subtree.
export function automaticExclusions(entries, read) {
  const excluded = new Map();
  for (const entry of entries) {
    if (!entry.container || entry.size > 128 * 1024) continue;
    const path = entry.path;
    const peers = file => file.container?.hash === entry.container.hash;
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    if (/\/(?:assets|vendor|third[_-]?party|lib)\/[^/]+\/README\.md$/iu.test('/' + path)) {
      const documentation = read(entry).toString('utf8');
      if (/\b(?:copied from|(?:is )?a copy of)\b/iu.test(documentation) && /https:\/\/github\.com\//iu.test(documentation)) {
        for (const file of entries.filter(file => peers(file) && file.path.startsWith(folder))) {
          excluded.set(file.path, {path:file.path, kind:'third-party-copy', evidence:path});
        }
      }
    }
    if (!/(?:^|\/)sw\.js$/u.test(path)) continue;
    const index = entries.find(file => peers(file) && file.path === folder + 'index.html' && file.size <= 128 * 1024);
    if (!index || !/\b(?:precacheAndRoute|workbox)\b/iu.test(read(entry).toString('utf8')) ||
        !/\bsrc=["'][^"']*assets\/[^"'/]+-[\w-]{8,}\.js["']/iu.test(read(index).toString('utf8'))) continue;
    for (const file of entries.filter(file => peers(file) && file.path.startsWith(folder))) {
      const relative = file.path.slice(folder.length);
      if (/^(?:index\.html|(?:sw|registerSW|workbox-[\w-]+)\.js|assets\/[^/]+-[\w-]{8,}\.(?:js|css))$/iu.test(relative)) {
        excluded.set(file.path, {path:file.path, kind:'generated-web-assets', evidence:index.path + '；' + path});
      }
    }
  }
  return excluded;
}
