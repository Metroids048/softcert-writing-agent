const sentences = text => text.split(/(?<=[。！？])/u);
const proofMark = /［历史记载 M(\d+)］/gu;
const normalize = value => value.normalize('NFKC').replace(/\s+/gu,'');
const numeric = /\d+(?:\.\d+)?(?:\s*[%％]|\s*(?:次|毫秒|秒|倍|ms\b|s\b))/iu;
const outcome = /(?:实测|测得|读数|测试结果|结果显示|实跑|测量结果|观测到|命中率|接管率|通过率|降至|降到|升到|升至|提高到|降低到|\d\s*[%％]\s*(?:→|->))/iu;
const method = /(?:是否|至少|不低于|阈值|应当|要求|不得|设计目标)/u;

export function measuredClaim(sentence) {
  const text = normalize(sentence);
  if (/实测数据.{0,20}(?:一致|复算|分叉)|全部数字可复算|扫描发生了\d+次/u.test(text)) return true;
  return numeric.test(text) && outcome.test(text) &&
    (!method.test(text) || /实测|测得|降低到|升(?:到|至)/u.test(text));
}

export function attributeMeasurements(value, row, facts) {
  return sentences(value).map(sentence=>{
    if (!measuredClaim(sentence) || [...sentence.matchAll(proofMark)].length) return sentence;
    const quote = sentence.trim();
    const key = JSON.stringify([row.path,row.loc,quote]);
    if (!facts.has(key)) facts.set(key,{id:facts.size+1,path:row.path,loc:row.loc,ocr:row.ocr,quote});
    const fact = facts.get(key);
    return '［历史记载 M'+fact.id+'］原件记载（本次未复测），'+quote;
  }).join('');
}

export function measurementReport(facts, entries) {
  if (!facts.length) return '';
  return ['# 实测数字来源对照','',
    '正文的历史记载仅引用本案收到的材料。涉及扫描识别的值须回读原页。本次运行复验以原始输出、运行条件和版本记录为准。','',
    ...facts.flatMap(fact=>['## M'+fact.id,'',
      '- 原件 '+fact.path+' '+fact.loc+(fact.ocr?'（物理页，OCR 待校）':''),'',
      '- SHA-256 '+entries.find(file=>file.path===fact.path)?.hash,'',
      '- 原件记载 '+fact.quote,'','- 当前状态 历史记载，本次未复测。','']),
  ].join('\n');
}

export function unverifiedMeasurements(text, report, entries) {
  // Rejoin wrapped lines so a split label or number on the rendered page still gets checked.
  const actual = text.normalize('NFKC').replace(/\s+/gu,'');
  return sentences(actual).filter(sentence=>{
    if (!measuredClaim(sentence)) return false;
    const mark = sentence.match(/\[历史记载M(\d+)\]原件记载\(本次未复测\),?/u);
    if (!mark) return true;
    const clause = sentence.slice(mark.index+mark[0].length).replace(/^，/u,'');
    const evidence = report.split(/^## M(?=\d)/mu).find(section=>section.startsWith(mark[1]+'\n'));
    return !evidence || !entries.some(file=>evidence.includes('- 原件 '+file.path+' ') &&
      evidence.includes('- SHA-256 '+file.hash)) || !normalize(evidence).includes(normalize(clause));
  });
}
