import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildFilingDraft} from '../filing/evidence.mjs';
import {checkApplication} from '../application-check.mjs';
import {separateManualClaims} from '../filing/manual-claims.mjs';

const opening = '本说明书描述该软件的安装、配置、操作与结果判读方法';
const operation = '在任务列表中选择已保存的任务，运行后可查看输出结果并保存截图。';
const oldClaim = '全部截图与输出均取自软件实际运行';

function draft(lines, {path='旧版操作手册.pdf',ocr=false,translate=async()=>new Map()}={}) {
  const evidence = {path,hash:'test-upload'};
  const details = [{path,pages:[{lines}],ocr:ocr ? {pages:[{page:1,lines}]} : undefined}];
  const inspected = {report:{files:[{...evidence,role:'manual'}]},details};
  const check = checkApplication(inspected,{groups:{release:[],target:[]}},new Set());
  return buildFilingDraft({softwareName:'任务整理器',version:'V2.0'},inspected,[evidence],[],null,()=>{},translate,check);
}

test('旧扫描件的实操声明不能进入新正文，保留同句介绍和原页出处', async () => {
  const result = await draft([opening+'，全部截图与', '输出均取自软件实际运行。',operation],{ocr:true});
  assert.doesNotMatch(result.manual,new RegExp(oldClaim,'u'));
  assert.doesNotMatch(result.form,new RegExp(oldClaim,'u'));
  assert.ok(result.manual.includes(opening+'。'));
  assert.ok(result.manual.includes(operation));
  assert.match(result.checklist,/旧版操作手册\.pdf 第 1 页（OCR 待校）/u);
  assert.match(result.checklist,/开发方.{0,45}同版/u);
});

test('文档作者的英文实操声明不会进入待翻译正文，操作文字仍可翻译', async () => {
  const claim = 'All screenshots and outputs in this manual were captured from actual software runs.';
  const step = 'Run the application and check the output to confirm the task is complete.';
  const result = await draft(['## Usage',claim,step],{
    path:'User guide.md',translate:async values=>{
      assert.ok(!values.includes(claim));
      return new Map([['Usage','操作步骤'],[step,operation]]);
    },
  });
  assert.ok(result.manual.includes(operation));
  assert.match(result.checklist,/User guide\.md 第 2 行/u);
});

test('终件的分行承诺可检出，保留操作步骤和待核措辞', () => {
  for (const text of ['本手册的全部截图由软件\n在实际运行时截取。','以下运行结果均为\n实机运行生成。',
    'The screenshots were taken\nduring live software runs.']) {
    assert.equal(separateManualClaims(text).claims.length,1,text);
  }
  for (const text of [operation,'截图可取自软件实际运行。','截图并非取自软件实际运行。',
    '运行后，实际运行核从日志读取任务状态。','Screenshots should be captured from actual software runs.']) {
    assert.deepEqual(separateManualClaims(text),{text,claims:[]});
  }
});
