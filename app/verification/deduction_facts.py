"""Check the deductions against browser downloads and the frozen parent uploads."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import sys
from zipfile import ZipFile

from pypdf import PdfReader


current, parent, intake_failure = map(Path, sys.argv[1:])
results = {}


def receipt(root, case):
    return json.loads((root / case / '网页回执.json').read_text())


def read_manual(package, prefix):
    content = package.read(f'{prefix}/申报准备/说明书.pdf')
    pages = PdfReader(BytesIO(content), strict=True).pages
    text = []
    for number, page in enumerate(pages, 1):
        assert abs(float(page.mediabox.width) - 595.28) < 0.1
        assert abs(float(page.mediabox.height) - 841.89) < 0.1
        words = page.extract_text()
        assert f'第 {number} 页' in words
        text.append(words)
    return content, '\n'.join(text), len(pages)


for case in ('miniPaint', 'miniPaint-错版', 'miniPaint-换产物', 'PhysicsBlocks', 'Apple',
             'miniPaint-完整源码', 'miniPaint-新增实操'):
    run = receipt(current, case)
    result = results[case] = {}
    if (parent / case / '网页回执.json').is_file():
        previous = receipt(parent, case)
        assert all(run[key] == previous[key] for key in ('request', 'uploads', 'target')), case
        result['sameParentInputs'] = True
    assert not run['errors'] and [s['http'] for s in run['stages']] == [200, 200, 200], case
    audit = run['zipReceipt']
    assert audit['id'] == run['stages'][-1]['payload']['audit']['id']
    result.update(receipt=audit['id'], case=audit['caseId'], policy=run['stages'][-1]['payload']['policy'])
    folder = current / case
    for item in run['downloads']:
        assert sha256((folder / item['filename']).read_bytes()).hexdigest() == item['sha256'], item['filename']

    with ZipFile(folder / '实际网页-内部审阅包.zip') as package:
        assert json.loads(package.read('审核回执.json')) == audit
        if case in ('miniPaint', 'miniPaint-完整源码', 'miniPaint-新增实操'):
            pdf, text, count = read_manual(package, '经审核材料')
            direct = next(item['filename'] for item in run['downloads'] if item['filename'].endswith('-说明书.pdf'))
            assert (folder / direct).read_bytes() == pdf
            assert '〔miniPaint 使用说明书.md 第 34 行〕' in text and '原文档记载的功能与兼容性' in text
            assert all(term in text for term in ('反相', '马赛克', '锐化', '旧版 Flash 插件'))
            assert not re.search(r'过时的闪存|摩塞克|不会传给服务器|\bURL s\b', text)
            checklist = package.read('经审核材料/申报准备/申请人补件清单.md').decode()
            assert 'miniPaint 使用说明书.md 第 5 行' in checklist and '实际部署与网络记录' in checklist
            layout = next(f['layout'] for f in audit['allowed'] if f['kind'] == 'filing-manual')
            assert count == len(layout['bodyRows']) and min(layout['bodyRows']) >= 30
            result['manualBodyRows'] = layout['bodyRows']
            if case == 'miniPaint-新增实操':
                steps = audit['draftingFacts']['operations']
                assert len(steps) == audit['runtimeEvidence']['matched'] == 4
                issued = [package.read('经审核材料/' + f['path']).decode() for f in audit['allowed']
                          if f['kind'] in ('filing-form', 'filing-manual-text')]
                assert len(issued) == 2
                for fact, menu in zip(steps[2:], ('Edit > Undo', 'Edit > Redo')):
                    assert menu in fact['action']
                    for value in (fact['action'], *fact['results']):
                        assert all(value in artifact for artifact in [text, *issued]), value
                result['orderedMenuActions'] = [x['action'] for x in steps[2:]]
            if case == 'miniPaint-完整源码':
                before = json.loads(intake_failure.read_text())
                assert run['uploads'] == before['uploads']
                assert before['stages'][0]['http'] == 400 and '180' in before['stages'][0]['payload']['error']
                assert not any(item['filename'].endswith('.pdf') and '交存源码' in item['filename']
                               for item in run['downloads'])
                mapping = json.loads(package.read('源码行号映射.json'))
                source_pdf_actions = [action for action in audit['actions']
                                      if '源码交存 PDF' in action['detail'] and '超出可读版式' in action['detail']]
                assert mapping['rows_per_page'] > 66 and len(source_pdf_actions) == 2
                result.update(oldUploadStatus=400, currentUploadStatus=200,
                              plannedRowsPerPage=mapping['rows_per_page'], mappedSourceFiles=len(mapping['files']))
        elif case == 'PhysicsBlocks':
            _, text, count = read_manual(package, '待核草稿')
            assert '用户手册.tex' in text and '登记表填写内容.md' in text
            draft = next(item for item in audit['drafts'] if item['file']['kind'] == 'filing-manual')
            body_rows = draft['file']['layout']['bodyRows']
            assert count == len(body_rows) and min(body_rows) >= 30
            assert draft['reason'].startswith('申请表功能待核')
            assert not any(item['filename'].endswith('-说明书.pdf') for item in run['downloads'])
            result.update(manualBodyRows=body_rows, remaining=draft['reason'])
        elif case == 'Apple':
            transcript = package.read('识别文本/Apple II DOS 使用说明书.pdf.OCR.txt').decode()
            block = transcript.split('【原 PDF 第 16 页】')[1].split('【原 PDF 第 17 页】')[0]
            assert all(value in block for value in ('SAVE OOUNT', '首遍 OOUNT，复读 COUNT', '首遍 SAVF，复读 SAVE'))
            original = package.read('待核原件/Apple II DOS 使用说明书.pdf')
            digest = next(item['sha256'] for item in run['uploads'] if item['name'] == 'Apple II DOS 使用说明书.pdf')
            assert sha256(original).hexdigest() == digest
            assert len(re.findall(r'^【原 PDF 第 \d+ 页】$', transcript, flags=re.MULTILINE)) == 110
            result.update(scannedPages=110, recoveredPage=16, originalSha256=digest)

assert len({result['policy'] for result in results.values()}) == 1
print(json.dumps(results, ensure_ascii=False, indent=2))
