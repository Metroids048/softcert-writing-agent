// Match literals against the selected release only. Never run commands from uploads.
const token = /(?<![\w-])--?[A-Za-z][\w-]*|(?:\/[\w.-]+|[\w@][\w.-]*)(?:\/[\w.-]+)*/gu;
const technical = /\/|^-|^CONFIG_[A-Z]|\.(?:sh|exe|py|gz|txt|log|csv)$|^\w+-syste[mn]-|^ttyS|^\w+Image$|^[a-z]+_[a-z\d_]+$|^aw[l1I]?k$/u;
const confusable = value => value.normalize('NFKC').replace(/[1lI]/gu,'l').replace(/[0O]/gu,'0')
  .replace(/^[gq](?=emu-)/u,'q').replace(/-syste[mn]-/gu,'-system-').replace(/^awlk$/u,'awk');
const shell = /^(?:[\w.-]+\/)*[\w.-]+(?:\.sh|system-[\w.-]+)\\?$|^(?:bash|sh|cd|cat|make|ls|1s|pipx|brew|python\S*)\s|^(?:[\w.-]+\/)+[\w.-]+\s+--|^-[\w-]+\s/u;
const handle = value => value.normalize('NFKC').trim();
const tokens = value => (value.match(token) ?? []).filter(item=>technical.test(item) && /[a-z]/i.test(item));
const candidates = value => tokens(value.replace(/(CONFIG_[A-Z_]+)\s+(_[A-Z_]+)/gu,'$1$2')).map(item=>item.replace(/[.]$/u,''));
const simple = /^(bash|sh|cat)\s+([\w./-]+)$/u;
const assignment = /(?<![\w=/-])([a-z][\w.-]*)=([A-Za-z0-9_./:+-]+(?:,[A-Za-z0-9_./:+-]+)*)(?![\w=,/$%.-])/gu;
const quotedOption = /(?:^|\s)-{1,2}[\w-]+[ \t]+\\?(["'])([^"'\n]+)\\?\1/gu;
const assignmentShape = value => value.replace(/[0oO]/gu,'0').replace(/[1lI]/gu,'1').replace(/[sS5]/gu,'5');
const assignments = text => [...text.matchAll(assignment)].filter(([,key])=>/[a-z]/u.test(key));
const assignmentMark = fact => '［字面 '+fact.id+'］';
const outcome = /\b([A-Z0-9_]+(?:-[A-Z0-9_]+)+)\s+(?:(?:(?:PASS|FAIL)\s+)?[A-Za-z_][\w.-]*\s*=\s*[+\-\w]+|\.\.\.\s+[A-Z0-9_]+-END\b)/gu;
export const outputText = fact => fact.value ? fact.value+'（原页示例，待同版实跑）' : fact.label+'（原页输出字面待核）';
const outputRecord = fact => '- '+fact.path+' 物理第 '+fact.page+' 页｜OCR 原读数 `'+fact.raw+'`｜'+
  (fact.value ? '同页文本层 `'+fact.value+'`，实际运行待同版核验。' : '同页文本层无唯一对应输出，核对原页。');

function matchAssignment(key,value,options) {
  const shape = assignmentShape(value);
  const supported = options.filter(item=>item.key === key && (assignmentShape(item.value) === shape ||
    !value.includes(',') && assignmentShape(item.value.split(',')[0]) === shape));
  if (new Set(supported.map(item=>item.value)).size !== 1) return {supported};
  const full = supported[0].value;
  return {value:value.includes(',') ? full : full.split(',')[0],full,supported};
}

export function crossCheckOCR(pages, entries, paths, read) {
  const originals = new Map(entries.map(file=>[file.path,file]));
  const lexicon = new Map();
  const fuzzy = new Map();
  const options = [];
  function add(word, source) {
    if (!lexicon.has(word)) lexicon.set(word,source);
    const key = confusable(word);
    if (!fuzzy.has(key)) fuzzy.set(key,new Set());
    fuzzy.get(key).add(word);
  }
  for (const path of new Set(paths)) {
    const file = originals.get(path);
    if (!file) continue;
    const base = {path,hash:file.hash};
    const names = path.split('/');
    for (let index = 0; index < names.length; index++) add(names.slice(index).join('/'),base);
    const lines = read(file).toString('utf8').split(/\r?\n/);
    for (const [index,line] of lines.entries()) {
      if (/\.(?:sh|bash)$/iu.test(path) && !/^\s*#/u.test(line)) {
        for (const [,,argument] of line.matchAll(quotedOption)) {
          for (const [,key,value] of assignments(argument)) options.push({key,value,path,hash:file.hash,line:index+1});
        }
      }
      for (const item of candidates(line)) add(item,{...base,line:index+1});
    }
  }
  const findings = [];
  const rows = [];
  const used = new Set();
  const prose = new Map();
  const assignmentsFound = [];
  const outputs = [];
  for (const page of pages.filter(page=>page.ocr)) {
    const replacements = new Map();
    prose.set(page,replacements);
    const rawLines = new Set([...page.lines,...(page.bodyLines ?? [])].map(handle));
    const recognizedOutputs = new Set([...rawLines].flatMap(line=>[...line.matchAll(outcome)].map(([,label])=>label)));
    for (const sample of page.outputExamples ?? []) {
      if (!recognizedOutputs.has(sample.trim().split(/\s+/u)[0])) rawLines.add(handle(sample));
    }
    for (const raw of rawLines) {
      const output = raw.replace(outcome,(literal,label)=>{
        const matches = [...new Set((page.outputExamples ?? []).map(handle).filter(line=>line.startsWith(label+' ')))];
        const fact = {path:page.path,page:page.number,raw:literal,label,value:matches.length === 1 ? matches[0] : null};
        outputs.push(fact);
        return outputText(fact);
      });
      if (output !== raw) {
        replacements.set(raw,output+'。');
        continue;
      }
      const command = shell.test(raw);
      const literals = [...new Set(candidates(raw))];
      const parameters = new Set(assignments(raw).filter(match=>{
        const [,key,value] = match;
        return /[A-Za-z]/u.test(value) || options.some(item=>item.key === key) ||
          /(?:参数|选项|配置)\s*[:：("' ]*$/u.test(raw.slice(0,match.index));
      }).map(([literal])=>literal));
      if (!command && !literals.length && !parameters.size) continue;
      const checked = [];
      const missing = [];
      for (const item of literals) {
        const similar = fuzzy.get(confusable(item));
        const exact = lexicon.has(item) ? item : similar?.size === 1 ? [...similar][0] : null;
        if (!exact) missing.push(item);
        else checked.push({ocr:item,value:exact,source:lexicon.get(exact)});
      }
      const invocation = raw.match(simple);
      const operand = checked.find(item=>item.ocr === invocation?.[2]);
      const supported = operand && (invocation[1] === 'cat' ? operand.value.startsWith('/') && operand.source.line :
        operand.value.endsWith('.sh') && !operand.source.line);
      const verifiedCommand = supported ? invocation[1]+' '+operand.value : null;
      if (verifiedCommand && !used.has(verifiedCommand)) {
        used.add(verifiedCommand);
        const purpose = invocation[1] === 'cat' ? '读取原说明书指定的文件' : '调用上传的同版脚本';
        rows.push({...page,topic:'',form:false,loc:'第 '+page.number+' 页',
          value:purpose+'：`'+verifiedCommand+'`。'});
      }
      if (command || missing.some(item=>item.includes('/') || item.startsWith('-') || item.includes('.') || /^aw[l1I]k$/u.test(item))) {
        replacements.set(raw,'');
      } else if (checked.length || parameters.size) {
        let corrected = raw.replace(/(CONFIG_[A-Z_]+)\s+(_[A-Z_]+)/gu,'$1$2');
        corrected = corrected.replace(assignment,(literal,key,value)=>{
          if (!parameters.has(literal)) return literal;
          const matched = matchAssignment(key,value,options);
          const fact = {id:'L'+(assignmentsFound.length+1),original:page.path,page:page.number,raw:literal,key,ocr:value,...matched};
          assignmentsFound.push(fact);
          return matched.value ? key+'='+matched.value+assignmentMark(fact) : '参数 '+key+'（字面待核）'+assignmentMark(fact);
        });
        for (const item of checked) if (item.value !== item.ocr) corrected = corrected.replaceAll(item.ocr,item.value);
        replacements.set(raw,corrected);
      }
      findings.push({original:page.path,page:page.number,raw,checked,missing,command,verifiedCommand});
    }
  }
  return {findings,rows,prose,assignments:assignmentsFound,outputs};
}

export function exampleLine(fact) {
  return '同版源码静态示例 '+assignmentMark(fact)+' · '+fact.key+'='+fact.full+'。运行结果待同版核验。';
}

function assignmentReport(fact) {
  return [
    '## '+assignmentMark(fact)+' '+fact.original+' 物理第 '+fact.page+' 页','',
    '- OCR 原读数 `'+fact.raw+'`',
    fact.value ? '- 原页转录采用 `'+fact.key+'='+fact.value+'`。'+exampleLine(fact) :
      '- '+(fact.supported.length ? '同版候选存在冲突' : '缺可核同版参数依据')+'，正文标为字面待核。请查原页及参数上下文。',
    ...fact.supported.map(item=>'- '+item.path+' 第 '+item.line+' 行｜`'+item.key+'='+item.value+'`｜SHA-256 '+item.hash),
    '',
  ].join('\n');
}

export function ocrReport(findings, facts, outputs = []) {
  if (!findings.length && !facts.length && !outputs.length) return '';
  return ['# OCR 命令与路径校对','',
    '页号按 PDF 物理页计。逐条列出 OCR 原读数、同版源码依据和缺项。单一脚本调用或文件读取在找到目标依据时可写入说明书。其余匹配只确认字面项，完整命令、参数顺序及运行结果仍须核验。','',
    ...facts.map(assignmentReport),
    ...outputs.map(outputRecord),
    ...findings.flatMap(({original,page,raw,checked,missing,command,verifiedCommand})=>[
      '## '+original+' 第 '+page+' 页','',
      '- OCR 原读数 `'+raw.replaceAll('`','＇')+'`',
      ...checked.map(({ocr,value,source})=>'- `'+ocr+'` → `'+value+'`｜'+source.path+
        (source.line ? ' 第 '+source.line+' 行' : ' 上传路径')+'｜SHA-256 '+source.hash),
      ...(missing.length ? ['- 缺同版依据 '+missing.map(item=>'`'+item+'`').join('、')] : []),
      ...(verifiedCommand ? ['- 说明书采用 `'+verifiedCommand+'`。运行结果待同版验证。'] :
        command ? ['- 此命令保留待核，须核对原扫描页上的完整命令和运行结果。'] : []),'',
    ])
  ].join('\n');
}

export function verifyOcrOutputs(facts, text, report) {
  const compact = value => value.normalize('NFKC').replace(/\s+/gu,'');
  const actual = compact(text);
  return facts.filter(fact=>{
    const label = compact(fact.label);
    if (!actual.includes(label)) return false;
    const expected = compact(outputText(fact));
    return !actual.includes(expected) || !report.includes(outputRecord(fact)) ||
      actual.replaceAll(expected,'').includes(label+'PASS') ||
      actual.replaceAll(expected,'').includes(label+'FAIL');
  });
}

// Recompute from the audited original scans and frozen source, then read the actual candidate text.
export function verifyOcrAssignments(facts, text, report, examples, tableFacts = []) {
  const normalize = value => value.normalize('NFKC').replace(/\s+/gu,'');
  const actual = normalize(text);
  return facts.filter(fact=>{
    const marker = normalize(assignmentMark(fact));
    const expected = fact.value ? fact.key+'='+fact.value : '参数'+fact.key+'（字面待核）';
    const related = assignments(text.normalize('NFKC')).filter(([,key,value])=>key === fact.key &&
      assignmentShape(value.split(',')[0]) === assignmentShape(fact.ocr.split(',')[0]));
    if (tableFacts.includes(fact) && !actual.includes(normalize(expected)+marker)) {
      return !report.includes(assignmentReport(fact)) ||
        !actual.includes(normalize(exampleLine(fact))) ||
        related.some(([,key,value])=>key === fact.key && value !== fact.value && value !== fact.full);
    }
    if (!actual.includes(marker) && !related.length) return false;
    return !actual.includes(normalize(expected)+marker) ||
      related.some(([,key,value])=>key === fact.key && value !== fact.value && value !== fact.full) ||
      !report.includes(assignmentReport(fact)) ||
      examples && fact.value && !actual.includes(normalize(exampleLine(fact)));
  });
}

