import assert from 'node:assert/strict';
import test from 'node:test';
import { draftingRequest, materialIntent, materialScope, requiredDelivery, reviewOnlyRequest } from '../deliverables.mjs';

test('identify a complete request, a single deliverable and a review request', () => {
  assert.deepEqual(materialScope('帮我准备一套软著材料。',null,false),['form','manual','source']);
  assert.deepEqual(materialScope('我已上传原件，帮我整理完整的软件著作权登记材料。',null,true),['form','manual','source']);
  assert.deepEqual(materialScope('给我说明书 PDF，源码已附。',null,false),['manual']);
  assert.deepEqual(materialScope('请帮我出交存源码 PDF。',null,false),['source']);
  assert.equal(draftingRequest('给我说明书 PDF。'),true);
  assert.equal(reviewOnlyRequest('仅复核说明书，不用起草。'),true);
  assert.deepEqual(materialScope('请生成申请表底稿、说明书和源码交存 PDF。',['source'],true),['source']);
});

test('program identification material is the source deliverable', () => {
  assert.deepEqual(materialScope('请生成申请表底稿、使用说明书 PDF、程序鉴别材料 PDF。',null,true),
    ['form','manual','source']);
  assert.deepEqual(materialScope('仅要说明书 PDF，暂不交程序鉴别材料。',null,false),['manual']);
});

test('a follow-up can retain the manual and add the source filing PDF', () => {
  const request = '请保留现有说明书 PDF 和原有步骤，再补回源码交存 PDF，暂不交申请表。';
  const work = materialIntent(request,null,true);
  assert.deepEqual(work.expected,['manual','source']);
  assert.deepEqual(work.excluded,['form']);
  assert.equal(work.draftRequested,true);
  assert.deepEqual(materialScope('再补回源码交存 PDF。',null,false),['source']);
});

test('review of provided material reads the originals without requiring a delivery selection', () => {
  const original = '请审核我提供的操作材料，保留有待核对的原件。';
  const work = materialIntent(original,null,false);
  assert.equal(work.readOnly,true);
  assert.equal(work.needsConfirmation,false);
  assert.deepEqual(work.expected,[]);
  assert.equal(reviewOnlyRequest('请审核我上传的旧说明书，再生成说明书 PDF。'),false);
  assert.equal(draftingRequest('请审核我上传的旧说明书，再生成说明书 PDF。'),true);
});

test('a Word draft or an uploaded PDF without content verification cannot fill a missing source volume', () => {
  const eligible = [
    {path:'front.pdf',hash:'front',kind:'source-pdf',volume:'front_30'},
    {path:'back.docx',hash:'word',kind:'source-docx',volume:'back_30'},
    {path:'uploaded.pdf',hash:'current',kind:'uploaded-source-pdf'},
  ];
  const [source] = requiredDelivery(['source'],eligible,[{path:'uploaded.pdf',sha256:'previous',volume:'back_30'}],
    ['front_30','back_30'],'draft',new Map());
  assert.equal(source.status,'待补');
  assert.deepEqual(source.missing,['源程序交存 PDF（后30页）']);
  assert.deepEqual(source.files,[{path:'经审核材料/front.pdf',sha256:'front'}]);
});
