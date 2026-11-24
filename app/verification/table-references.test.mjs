import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTableReferences, tableCaptions, tableIndex, unverifiedTableReferences, withoutTableReferences } from '../filing/table-references.mjs';

const path = '原手册.pdf';
const text = '操作结果见表 3。';
const entries = [{path,hash:'authentic-input'}];

test('a visible reference and index must point back to the unique caption of the original PDF',()=>{
  const pages = [{lines:[text]},{lines:['表 3：操作结果']}];
  const targets = tableCaptions([{path,pages}],entries);
  const used = new Set();
  const actual = bindTableReferences(text,path,targets,used);
  const report = tableIndex([...used]);
  assert.match(actual,/表 3［同包原件《原手册\.pdf》物理第 2 页］/u);
  assert.equal(withoutTableReferences(actual),text);
  assert.deepEqual(unverifiedTableReferences(actual,report,targets),[]);
  assert.deepEqual(unverifiedTableReferences(actual.replace('第 2 页','第 1 页'),report,targets),['表3']);
  assert.deepEqual(unverifiedTableReferences(actual,report.replace('authentic-input','old-input'),targets),['表3']);
  assert.deepEqual(unverifiedTableReferences(text,report,targets),['表3']);
  const counter = '历史表 512 条，参见表 3。';
  const linked = bindTableReferences(counter,path,targets,new Set());
  assert.match(linked,/历史表 512 条，参见表 3［同包原件/u);
  assert.deepEqual(unverifiedTableReferences(linked,report,targets),[]);
});

test('an OCR caption can fill a reference, but mentions and duplicate captions cannot supply a landing page',()=>{
  const first = {lines:[text]};
  const ocr = {pages:[{page:2,captions:['表3: 操作结果'],lines:['说明见表 3。']}]};
  const build = pages=>tableCaptions([{path,pages,ocr}],entries);
  assert.equal(build([first,{lines:[]}]).length,1);
  const targets = build([first,{lines:[]},{lines:['表3: 另一组操作结果']}]);
  const actual = bindTableReferences(text,path,targets,new Set());
  assert.match(actual,/原件图表位置待核/u);
  assert.deepEqual(unverifiedTableReferences(actual,'',targets),['表3']);
});
