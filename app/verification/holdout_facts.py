"""Check the real browser receipts and delivered bytes of the three frozen cases."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import sys
from zipfile import ZipFile

from pypdf import PdfReader


root = Path(sys.argv[1])
cases = ('miniPaint', 'miniPaint-错版', 'miniPaint-换产物', 'PhysicsBlocks', 'Apple')
findings = {}

for case in cases:
    folder = root / case
    run = json.loads((folder / '网页回执.json').read_text())
    assert [stage['http'] for stage in run['stages']] == [200, 200, 200], case
    assert not run['errors'], (case, run['errors'])
    state = run['stages'][-1]['payload']
    downloaded = {item['filename']: item['sha256'] for item in run['downloads']}
    for filename, expected in downloaded.items():
        assert sha256((folder / filename).read_bytes()).hexdigest() == expected, (case, filename)

    with ZipFile(folder / '实际网页-内部审阅包.zip') as bundle:
        audit = json.loads(bundle.read('审核回执.json'))
        assert audit == run['zipReceipt'] and audit['id'] == state['audit']['id'], case
        assert audit['caseId'] == state['id'] and audit['revision'] == state['revision'], case
        assert not audit['filingReady'], case
        approved = {file['kind']: bundle.read('经审核材料/' + file['path'])
                    for file in audit['allowed']}
        for file in audit['allowed']:
            content = bundle.read('经审核材料/' + file['path'])
            assert file['hash'] == sha256(content).hexdigest(), (case, file['path'])

        runtime = audit['runtimeEvidence']
        facts = audit['draftingFacts']
        rows = {row['id']: row['quality'] for row in audit['rows']}
        if case == 'miniPaint':
            assert runtime['matched'] == len(facts['operations']) == 2
            assert 'Help > About' in facts['operations'][0]['action']
            form = approved['filing-form'].decode()
            manual = approved['filing-manual-text'].decode()
            pdf = approved['filing-manual']
            filename = next(name for name in downloaded if name.endswith('-说明书.pdf'))
            assert (folder / filename).read_bytes() == pdf
            pages = PdfReader(BytesIO(pdf)).pages
            text = re.sub(r'\s+', '', ''.join(page.extract_text() for page in pages))
            for fact in facts['operations']:
                for value in (fact['action'], *fact['results'], Path(fact['record']['path']).name):
                    assert value in form and value in manual, value
                    assert re.sub(r'\s+', '', value) in text, value
        else:
            assert 'filing-manual' not in approved and not any(
                name.endswith('-说明书.pdf') for name in downloaded), case
            assert runtime['matched'] == 0 and not facts['operations'], case
            if case == 'miniPaint-错版':
                assert audit['versionCheck']['status'] == 'conflict'
                assert 'filing-form' not in approved
            elif case == 'miniPaint-换产物':
                assert [record['status'] for record in runtime['records']] == ['运行产物不符']
                assert 'File > Export' not in approved['filing-manual-text'].decode()
            elif case == 'PhysicsBlocks':
                manual = approved['filing-manual-text'].decode()
                assert '登记表填写内容.md' in manual and '用户手册.tex' in manual and '软件说明书.tex' in manual
                assert '本地文件管理' in approved['filing-form'].decode()
                assert any('1–31、126–163' in issue['detail'] and '1–30、134–163' in issue['detail']
                           for issue in audit['issues'] if issue['id'] == 'R4')
            else:
                assert [rows[code] for code in ('R1', 'R2', 'R5', 'R6', 'R7')] == [0.5, 0, 0, 0, 0.5]
                assert {item['title'] for item in audit['versionCheck']['questions']} == {
                    '补发布版本证据', '补实际运行版本', '确认稿件适用版本'}
                assert 'filing-form' not in approved
        findings[case] = {'case': audit['caseId'], 'receipt': audit['id'], 'quality': audit['quality'],
                          'readiness': audit['formal'], 'matches': runtime['matched'], 'rows': rows}

print(json.dumps(findings, ensure_ascii=False, indent=2))
