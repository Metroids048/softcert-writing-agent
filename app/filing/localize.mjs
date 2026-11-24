import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export const english = text => /^[\s\p{P}\p{S}\dA-Za-z]+$/u.test(text) &&
  (text.match(/\b[a-z]{2,}\b/gi) ?? []).length >= 3 &&
  !/^(?:\w+:\s*)?(?:\/|[a-z_]+\.(?:py|sh|md)\b)/i.test(text);

export const englishTitle = text => /^[a-z][a-z0-9 /&-]*$/i.test(text) && /[a-z]{2}/i.test(text);
const glossary = new Map(Object.entries({
  'Installation':'安装','Syntax highlighting':'语法高亮','General Options':'通用选项','Style':'样式',
  'Exporting':'导出','Alignment':'对齐','Width':'宽度','Padding':'内边距','Network':'网络文件',
  'Reading from Stdin':'读取标准输入','Pager':'分页浏览','Rich Printing':'标记文本输出',
  'Soft wrapping':'软换行','Rules':'分隔线','Universal':'跨平台','Usage':'使用方法',
  'Requirements':'依赖条件','Quick start':'快速开始','Examples':'操作示例','Troubleshooting':'故障处理',
  'Windows / Linux':'Windows / Linux','MacOS':'macOS','Text Justify':'段内对齐','Panel':'边框面板',
  'Features':'功能列表','Browser Support':'浏览器兼容性',
}));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const translatedTerms = new Map(Object.entries({
  'outdated flash':'旧版 Flash 插件','data URLs':'数据 URL','URLs':'URL',
  'color corrections':'色彩校正','automatic color adjustment':'自动调整颜色',
  'luminance':'明度','hue':'色相','negative':'反相','flattening':'合并为单一图层',
  'sharpener':'锐化工具','sharpen':'锐化','magic wand':'魔棒工具','color picker':'取色器',
  'inpaint':'图像修复','mosaic':'马赛克','denoise':'降噪','desaturation':'去饱和',
  'dither':'抖动','vibrance':'自然饱和度','vignette':'暗角','tilt shift':'移轴',
}));
const terms = [...translatedTerms.keys()].map(escape).join('|');
const technical = /(?<!\w)(?:--[\w-]+|-[A-Za-z]\b|[A-Z][A-Z_\d]{2,}|[\w-]+\.(?:py|md|json|ipynb|html)|https?:\/\/[^ \])]+|\b(?:[Mm]arkdown|Jupyter|Homebrew|conda|mamba|pipx?|macOS|Windows|Linux|Python|ANSI|BBCode|page up\/down, home, end|ctrl[+_-][A-Za-z])\b)/gu;

export async function localizeEnglish(dir, root, values, identifiers = []) {
  const python = process.env.SOFTCERT_TRANSLATION_PYTHON || join(root,'.workbench/translation-venv/bin/python');
  const model = process.env.SOFTCERT_TRANSLATION_MODEL || join(root,'.workbench/translation/translate-en_zh-1_9');
  if (!existsSync(join(model,'sentencepiece.model')) || !existsSync(python)) return new Map();
  const names = [...new Set(identifiers.flatMap(value=>[value,value.replace(/^./u,char=>char.toUpperCase()),
    value.replace(/(^|-)([a-z]+)/gu,(_,prefix,word)=>prefix+
      (prefix && word.length<=3 ? word.toUpperCase() : word[0].toUpperCase()+word.slice(1)))]))]
    .sort((a,b)=>b.length-a.length).map(escape);
  const literalsPattern = new RegExp('`([^`]+)`|\\b('+terms+')\\b|'+technical.source+
    (names.length ? '|(?<![\\w-])(?:'+names.join('|')+')(?![\\w-])' : ''),'gu');
  const prepared = values.filter(value=>!glossary.has(value)).map(value=>{
    const literals = [];
    const masked = value.replace(literalsPattern,(all,quoted,term)=>{
      literals.push(quoted ?? (term ? translatedTerms.get(term) : all));
      return ' [T'+literals.length+'] ';
    });
    return {value,masked,literals};
  });
  if (!prepared.length) return new Map(values.map(value=>[value,glossary.get(value)]));
  const output = await new Promise((resolve,reject)=>{
    const task=execFile(python,[join(dir,'translate.py'),model],{timeout:110_000,maxBuffer:1024*1024},
      (error,stdout)=>error ? reject(error) : resolve(JSON.parse(stdout)));
    task.stdin.on('error',()=>{});
    task.stdin.end(JSON.stringify(prepared.map(item=>item.masked)));
  });
  const translated = new Map(values.filter(value=>glossary.has(value)).map(value=>[value,glossary.get(value)]));
  for (const [{value,literals},index] of prepared.map((item,index)=>[item,index])) {
    const result = output[index]?.replaceAll('▁',' ');
    if (!result) continue;
    const placeholders = [...result.matchAll(/\[\s*T\s*(\d+)\s*\]/giu)].map(([,number])=>Number(number));
    if (placeholders.length === literals.length && new Set(placeholders).size === literals.length &&
        placeholders.every(position=>position>0 && position<=literals.length) && !/[�⁇]/u.test(result) &&
        (result.match(/\p{Script=Han}/gu) ?? []).length >= 2) {
      const chinese = result
        .replace(/(命令行|指令行)工具箱/gu,'命令行工具')
        .replace(/花哨输出/gu,'格式化输出')
        .replace(/由(.{1,50}?)建造(?=[.。]|$)/gu,'基于 $1 构建')
        .replace(/由\s*(\[\s*T\s*\d+\s*\])\s*[.。]?$/gu,'基于 $1 构建。')
        .replace(/可作为\s*(\[\s*T\s*\d+\s*\])\s*包装/gu,'可作为 $1 软件包安装')
        .replace(/寻呼器|寻呼程序/gu,'分页器')
        .replace(/证明文本的合理性/gu,'设置文本对齐方式')
        .replace(/插入新行，从而将您的文本进行文字包装/gu,'插入换行符，使文本适应显示宽度')
        .replace(/启用缩进导(?=\s*[.。]|$)/gu,'显示缩进参考线')
        .replace(/_\s*lexer\s*_/giu,'词法分析器').replace(/_\s*padd?ing\s*_/giu,'内边距')
        .replace(/以制作出水平分隔线/gu,'绘制水平分隔线')
        .replace(/路径中应该有\s*(\[\s*T\s*\d+\s*\])\s*命令/gu,'应可在终端直接运行 $1')
        .replace(/从\s*标准输入\s*读取内容的\s*(\[\s*T\s*\d+\s*\])/gu,'$1 来读取标准输入')
        .replace(/语法加亮|漂亮格式化和突出显示/gu,word=>word==='语法加亮'?'语法高亮':'格式化和高亮')
        .replace(/将行包起来/gu,'自动换行').replace(/文字包装|来包装/gu,'换行')
        .replace(/文件以\s*(\[\s*T\s*\d+\s*\])\s*(Markdown|\[\s*T\s*\d+\s*\])\s*结尾/giu,'$2 文件以 $1 结尾')
        .replace(/语法突出显示|突出显示语法/gu,'语法高亮')
        .replace(/标记下/gu,'Markdown').replace(/开关|切换(?=或|[，。])/gu,'选项')
        .replace(/您可以|你可以/gu,'可').replace(/富人/gu,'工具').replace(/视窗/gu,'Windows')
        .replace(/包装(?=，|、|。|或)/gu,'包').replace(/文字说明(?=方式|\s)/gu,'段内对齐')
        .replace(/将文本包起来|把文本包起来/gu,'自动换行').replace(/水平规则/gu,'水平分隔线')
        .replace(/命令行界面到 (\[\s*T\s*\d+\s*\])/gu,'$1 的命令行界面')
        .replace(/标准输入流|stdin/gu,'标准输入').replace(/写入一个 HTML\s*文件/gu,'导出 HTML 文件')
        .replace(/[ \t]+/gu,' ').replace(/ +([，。；：！？])/gu,'$1')
        .replace(/(?<=\p{Script=Han})\s*,\s*/gu,'，').replace(/(?<=\p{Script=Han})\s*[:：] *$/gu,'。')
        .replace(/(?<=\p{Script=Han})\.$/gu,'。').replace(/(\[)\s*$/gu,'')
        .replace(/\[\s*T\s*(\d+)\s*\]/giu,(_,number)=>literals[Number(number)-1]).trim();
      if (literals.every(item=>chinese.includes(item))) {
        translated.set(value,chinese);
      }
    }
  }
  return translated;
}
