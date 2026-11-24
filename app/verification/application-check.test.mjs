import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkApplication} from '../application-check.mjs';

function check(...forms) {
  const files = forms.map((_,index)=>({path:'申请表-'+index+'.md',role:'form',hash:String(index)}));
  const details = files.map(({path},index)=>({path,pages:[{lines:forms[index].split('\n')}]}));
  return checkApplication({report:{files},details},{groups:{release:[],target:[]}},new Set());
}

test('实际填写值进入权属，后文事项表不进入底稿或补件', () => {
  const evidence = process.env.SOFTCERT_CASE_EVIDENCE;
  const original = evidence ? readFileSync(join(evidence,'v0.3-双案实测/原始输入/申请表字段与功能描述.md'),'utf8') : [
    '# 申请表底稿', '', '本文供登记准备使用。', '请核对填写值。', '', '## 申请信息', '',
    '| 字段 | 填写内容 | 说明 |',
    '|---|---|---|',
    '| 软件全称 | 示例盘点工具 | |',
    '| 软件简称 | 盘点工具 | |',
    '| 版本号 | 1.0.0 | |',
    '| 开发完成日期 | 2024-01-01 | |',
    '| 首次发表日期 | 未发表 | |',
    '| 著作权人 | 示例软件社 | |',
    '| 开发方式 | 独立开发 | |', '',
    '## 补件说明',
    '| 事项 | 为什么要填 | 建议 |',
    '|---|---|---|',
    '| 开发方式 | 提供权属依据 | 合作开发时提供合同 |',
  ].join('\n');
  const rights = check(original).items[1];
  assert.deepEqual(rights.evidence.filter(hit=>hit.field==='开发方式').map(hit=>[hit.value,hit.location]),
    [['独立开发','第 16 行']]);
  assert.match(rights.next,/确认独立开发/u);
  assert.doesNotMatch(rights.next,/合作开发合同/u);
});

test('实际值列按表头识别，说明和示例不产生申请人、开发方式或签章', () => {
  const {items:[identity,rights,signature]} = check([
    '## 填写说明',
    '申请人：示例单位',
    '开发方式：委托开发',
    '### 样例',
    '签章：样例章',
    '## 本次申请信息',
    '| 字段 | 填写提示 | 实际值 |',
    '| --- | --- | --- |',
    '| 申请人 | 写法定名称 | 青禾软件社 |',
    '| 开发方式 | 如果是独立开发就填独立开发 | 合作开发 |',
    '| 签章 | 请盖章 | ［待签］ |',
    '',
    '| 事项 | 为什么要填 | 建议 |',
    '| --- | --- | --- |',
    '| 著作权人 | 示例单位 | 仅演示 |',
  ].join('\n'));
  assert.deepEqual(identity.evidence.map(hit=>hit.value),['青禾软件社']);
  assert.deepEqual(rights.evidence.filter(hit=>hit.field==='开发方式').map(hit=>hit.value),['合作开发']);
  assert.match(rights.next,/提供已签署的合作开发合同/u);
  assert.equal(signature.status,'missing');
});

test('没有实际值的字段保持待补，文字提示和未选择选项不会触发合作补件', () => {
  const {items:[identity,rights]} = check([
    '| 字段 | 填写内容 | 说明 |',
    '| --- | --- | --- |',
    '| 申请人 | | 有效身份证明上的全称 |',
    '| 开发方式 | 独立开发 / 合作开发 | 请选择 |',
    '',
    '开发方式：如果与他人合作，请填合作开发',
  ].join('\n'));
  assert.equal(identity.status,'missing');
  assert.deepEqual(rights.evidence,[]);
  assert.doesNotMatch(rights.next,/合作开发合同/u);
});

test('单行及相邻段落的真实开发方式仍然有效，两份实际填写不一致时提示确认', () => {
  const entrusted = check('开发方式\n委托开发').items[1];
  assert.match(entrusted.next,/提供签署完整的委托开发合同/u);
  const rights = check('开发方式：独立开发','开发方式：合作开发').items[1];
  assert.equal(rights.status,'conflict');
  assert.match(rights.summary,/开发方式/u);
  assert.doesNotMatch(rights.next,/合作开发合同/u);
});
