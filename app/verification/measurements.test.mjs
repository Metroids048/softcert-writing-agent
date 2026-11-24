import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeMeasurements, measurementReport, unverifiedMeasurements } from '../filing/measurements.mjs';

test('archive attribution keeps the claim and rejects a missing label, changed figure or wrong input hash',()=>{
  const row = {path:'原说明书.pdf',loc:'第 17 页',ocr:true};
  const entries = [{path:row.path,hash:'original-sha'}];
  const quote = '结果显示接管率由 97.9% 升至 98.1%。';
  const facts = new Map();
  const output = attributeMeasurements(quote,row,facts);
  const report = measurementReport([...facts.values()],entries);
  assert.match(output,/［历史记载 M1］原件记载（本次未复测），结果显示接管率由 97.9% 升至 98.1%/u);
  assert.deepEqual(unverifiedMeasurements(output.replace('97.9%', '97.\n9%'),report,entries),[]);
  assert.equal(unverifiedMeasurements(quote,report,entries).length,1);
  assert.equal(unverifiedMeasurements(output.replace('98.1%', '98.2%'),report,entries).length,1);
  assert.equal(unverifiedMeasurements(output,report,[{...entries[0],hash:'another-input'}]).length,1);
});

test('a defined acceptance threshold and reproduction input remain instructions',()=>{
  const text = '验证接管率是否至少达到 95%。设置 4 vCPU 后重复 5 次。';
  assert.equal(attributeMeasurements(text,{path:'原说明书.pdf',loc:'第 17 页'},new Map()),text);
});

test('an archived scan count with a workload condition is still a historical result',()=>{
  const row = {path:'说明书.pdf',loc:'第 12–13 页',ocr:true};
  const entries = [{path:row.path,hash:'original-sha'}];
  const quote = '早期版本无论池中是否有新作业都进行扫描；在 8 任务、512 次唤醒的负载下，这种扫描发生了 757 次。';
  const facts = new Map();
  const output = attributeMeasurements(quote,row,facts);
  const report = measurementReport([...facts.values()],entries);
  assert.match(output,/^［历史记载 M1］原件记载（本次未复测）/u);
  assert.match(report,/说明书\.pdf 第 12–13 页/u);
  assert.deepEqual(unverifiedMeasurements(output,report,entries),[]);
  assert.deepEqual(unverifiedMeasurements(quote,report,entries),[quote.replace(/\s+/gu,'').normalize('NFKC')]);
});
