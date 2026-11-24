const chineseClaim = /(?:截[图圖]|截屏|屏幕快照|运行(?:结果|输出)|(?:全部|所有|本文|本手册|上述|以下)输出)(?:(?!可|需|应|请|建议|尚未|并非|不|[。！？；])[^\n]){0,32}?(?:取自|来自|源自|来源于|截取自|采集自|(?:均|都|是)?(?:由|为|从))[^。！？；]{0,20}?(?:实际|实机|真实)[^。！？；]{0,10}?运行/u;
const englishClaim = /\b(?:screenshots?|run (?:outputs?|results?)|(?:all|the) outputs?)\b[^.!?;]{0,65}?\b(?:were|was|are|is)\s+(?:taken|captured|recorded|generated|obtained|collected)\s+(?:from|during|by)\b[^.!?;]{0,35}?\b(?:actual|live|real)\b[^.!?;]{0,25}?\b(?:runs?|running|execution)\b/iu;
const isClaim = text => {
  const normalized = text.replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu,'').replace(/\s+/gu,' ');
  return chineseClaim.test(normalized) || englishClaim.test(normalized);
};

export function separateManualClaims(text) {
  const claims = [];
  const body = text.split(/(?<=[。！？；!?])\s*|(?<=[.;])\s+/u).flatMap(sentence=>{
    if (!isClaim(sentence)) return [sentence];
    const clauses = sentence.split(/(?<=[，,])\s*/u);
    const matching = clauses.filter(isClaim);
    if (!matching.length) {
      claims.push(sentence);
      return [];
    }
    claims.push(...matching);
    const rest = clauses.filter(clause=>!isClaim(clause)).join(' ').trimEnd();
    return [rest.replace(/[，,]$/u,punctuation=>punctuation === '，' ? '。' : '.')];
  });
  return {text:claims.length ? body.join(' ').trim() : text,claims};
}
