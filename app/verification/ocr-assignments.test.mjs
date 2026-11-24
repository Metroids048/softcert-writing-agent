import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossCheckOCR, exampleLine, ocrReport, verifyOcrAssignments, verifyOcrOutputs } from '../filing/ocr-evidence.mjs';

const page = {path:'扫描手册.pdf',number:5,ocr:true,lines:['启动参数（serial=uartso），其余设置保持。']};
const inputs = [{path:'scripts/boot.sh',hash:'fixed'}, {path:'old/boot.sh',hash:'old'}];
const index = source => crossCheckOCR([page],inputs,['scripts/boot.sh'],
  file=>Buffer.from(file.hash === 'fixed' ? source : 'boot -args "serial=uart50,9600"'));

test('static agreement preserves the scan literal and labels the longer example',()=>{
  const result = index('boot -args "serial=uartS0,9600 idle=off"\necho "boot -args \\"serial=uartS0,9600\\""');
  const [fact] = result.assignments;
  const corrected = result.prose.get(page).get(page.lines[0].normalize('NFKC'));
  const report = ocrReport(result.findings,result.assignments);
  assert.equal(fact.value,'uartS0');
  assert.deepEqual(fact.supported.map(item=>item.line),[1,2]);
  assert.match(corrected,/serial=uartS0［字面 L1］/u);
  assert.match(exampleLine(fact),/serial=uartS0,9600/u);
  assert.deepEqual(verifyOcrAssignments([fact],corrected+'\n'+exampleLine(fact),report,true),[]);
  assert.deepEqual(verifyOcrAssignments([fact],corrected.replace('uartS0','uartso')+'\n'+exampleLine(fact),report,true),[fact]);
  assert.deepEqual(verifyOcrAssignments([fact],page.lines[0],report,true),[fact]);
  assert.deepEqual(verifyOcrAssignments([fact],corrected+'\n'+exampleLine(fact),report.replace('SHA-256 fixed','SHA-256 old'),true),[fact]);
});

test('conflict and missing source retain prose and require a literal check',()=>{
  for (const source of ['boot -args "other=uartS0,9600"','# boot -args "serial=uartS0,9600"',
    'boot -args "serial=uartS0,9600"\nboot -args "serial=uart50,19200"']) {
    const result = index(source);
    const [fact] = result.assignments;
    const corrected = result.prose.get(page).get(page.lines[0].normalize('NFKC'));
    const report = ocrReport(result.findings,result.assignments);
    assert.equal(fact.value,undefined);
    assert.match(corrected,/字面待核/u);
    assert.doesNotMatch(corrected,/uartso/u);
    assert.deepEqual(verifyOcrAssignments([fact],corrected,report,true),[]);
    assert.deepEqual(verifyOcrAssignments([fact],page.lines[0],report,true),[fact]);
  }
});

test('self-test wording requires a unique same-page PDF text and flags an old reading in the issued candidate',()=>{
  const page = {path:'guide.pdf',number:9,ocr:true,lines:['CHECK-HOST PASS IC=O'],
    outputExamples:['CHECK-HOST PASS rc=0']};
  const result = crossCheckOCR([page],[],[],()=>{});
  const report = ocrReport(result.findings,result.assignments,result.outputs);
  const corrected = result.prose.get(page).get(page.lines[0]);
  assert.match(corrected,/CHECK-HOST PASS rc=0（原页示例，待同版实跑）/);
  assert.deepEqual(verifyOcrOutputs(result.outputs,corrected,report),[]);
  assert.equal(verifyOcrOutputs(result.outputs,corrected+' '+page.lines[0],report).length,1);
  const conflict = {...page,outputExamples:[...page.outputExamples,'CHECK-HOST FAIL rc=1']};
  const conflicted = crossCheckOCR([conflict],[],[],()=>{});
  assert.match(conflicted.prose.get(conflict).get(page.lines[0]),/字面待核/);
});
