"""Verify the downloaded bytes independently of the web service."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import sys
from zipfile import ZipFile

from docx import Document
from pypdf import PdfReader
from pypdfium2 import PdfDocument

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "归档"
EVIDENCE = Path(sys.argv[1])
BROWSER = json.loads((EVIDENCE / "browser-evidence.json").read_text())
RUNS = BROWSER["runs"]


def checksum(data):
    return sha256(data).hexdigest()


def read_json(zip_file, name):
    return json.loads(zip_file.read(name))


def assert_audit(bundle, run, filename):
    receipt = read_json(bundle, "审核回执.json")
    files = {item["path"]: item for item in receipt["allowed"]}
    delivered = {name.removeprefix("经审核材料/") for name in bundle.namelist()
                 if name.startswith("经审核材料/") and not name.endswith("/")}
    assert delivered == set(files), (filename, delivered ^ set(files))
    assert receipt["id"] == run["audit"]["id"] and receipt["candidateId"] == run["candidate"]["id"]
    assert receipt["caseId"] == run["caseId"] and receipt["revision"] == run["revision"]
    assert not receipt["filingReady"]
    assert [item["id"] for item in receipt["rows"]] == [f"R{i}" for i in range(1, 8)]
    for path, item in files.items():
        content = bundle.read("经审核材料/" + path)
        assert len(content) == item["size"] and checksum(content) == item["hash"]
    assert not delivered.intersection(receipt["blocked"])
    return receipt


def target(bundle, receipt, kind):
    item = next(file for file in receipt["allowed"] if file.get("kind") == kind)
    return bundle.read("经审核材料/" + item["path"])


def check_source(bundle, receipt, originals, pages, synthetic=False, draft=False):
    mapping = read_json(bundle, "源码行号映射.json")
    total_pages = mapping["full_page_count"]
    if pages is None:
        assert total_pages >= 60
    else:
        assert total_pages == pages
    assert mapping["upstream"]["commit"] == "ee7d4636f35210767adc0b5689f8678c68e6f7e6"
    selected = {item["path"]: item for item in mapping["files"]}
    by_source = {}
    for path, item in selected.items():
        if synthetic and path.endswith("reservation-data.py"):
            raw = ("\n".join(f"item_{index} = {index}" for index in range(1, 3901)) + "\n").encode()
        else:
            raw = originals.read(path)
        assert checksum(raw) == item["sha256"]
        by_source[path] = raw.decode("utf-8-sig").splitlines()
    line_map = mapping["line_mapping"]
    assert [item["output_line"] for item in line_map] == list(range(1, len(line_map)+1))
    for item in line_map:
        source = item["file"]
        assert item["file_sha256"] == selected[source]["sha256"]
        assert by_source[source][item["source_line"]-1].strip()
    candidates = [item["file"] for item in receipt["drafts"]] if draft else receipt["allowed"]
    prefix = "待核草稿/" if draft else "经审核材料/"
    source_pdfs = {item["volume"]: item for item in candidates if item.get("kind") == "source-pdf"}
    volumes = mapping["filing_groups"]
    assert set(source_pdfs) == set(volumes)
    for volume, group in volumes.items():
        data = bundle.read(prefix + source_pdfs[volume]["path"])
        pdf = PdfReader(BytesIO(data))
        assert len(pdf.pages) == group["page_count"]
        for index, (page, logical) in enumerate(zip(pdf.pages, group["logical_source_pages"], strict=True)):
            assert abs(float(page.mediabox.width)-595.28) < 3
            assert abs(float(page.mediabox.height)-841.89) < 3
            text = page.extract_text()
            filing_no = index+31 if volume == "back_30" else index+1
            assert re.search(fr"第\s*{filing_no}\s*页", text)
            meta = mapping["pages"][logical-1]
            assert len([line for line in text.splitlines() if line.strip()]) >= meta["line_count"]
            assert (meta["effective_lines"] < 50) if draft else (meta["effective_lines"] >= 50)
        docx = next(item for item in candidates if item.get("kind") == "source-docx" and item["volume"] == volume)
        assert Document(BytesIO(bundle.read(prefix + docx["path"]))).paragraphs
    if synthetic:
        assert volumes["front_30"]["logical_source_pages"] == list(range(1,31))
        assert volumes["back_30"]["logical_source_pages"] == list(range(total_pages-29,total_pages+1))
    return {"sourceFiles":len(selected),"sourcePages":total_pages,
            "filingPages":{volume:entry["page_count"] for volume, entry in volumes.items()}}


ARTIFACTS = {
    "device":"设备预约台－内部审阅包.zip",
    "microblog":"Microblog－内部审阅包.zip",
    "hollowBefore":"Hollow－首次内部审阅包.zip",
    "hollow":"Hollow－补件后内部审阅包.zip",
    "stock":"库存盘点助手－内部审阅包.zip",
    "weak":"弱材料通用回归－内部审阅包.zip",
    "long":"长交存－前后分册验收包.zip",
}
device_archive = ARCHIVE / "04 模拟样例与网页原型/网页产物/自动修订版/模拟输入－设备预约台.zip"
micro_archive = ARCHIVE / "02 Microblog 开源实跑/Microblog 固定提交－源码.zip"
observed = {}
for name, path in ARTIFACTS.items():
    file = EVIDENCE / path
    fingerprint = checksum(file.read_bytes())
    assert fingerprint == BROWSER["fileHashes"][path] == RUNS[name]["archiveSha256"]
    with ZipFile(file) as bundle:
        receipt = assert_audit(bundle,RUNS[name],path)
        result = {"zipSha256":fingerprint,"allowed":len(receipt["allowed"]),
                  "quality":receipt["quality"],"readiness":receipt["formal"],"review":receipt["id"]}
        if name == "device":
            manual = target(bundle,receipt,"manual-pdf")
            manual_pdf = PdfReader(BytesIO(manual))
            words = "".join(page.extract_text() for page in manual_pdf.pages)
            assert "设备预约台 V2.6.0 操作手册" in words and "历史版本 V2.5.0" in words
            with PdfDocument(manual) as rendered:
                rendered[0].render(scale=1.4).to_pil().save(EVIDENCE/"设备预约台－实下载手册预览.png")
            changes = read_json(bundle,"逐处改动.json")
            assert len(changes) == 4
            with ZipFile(device_archive) as original:
                for file_path in {item["path"] for item in changes}:
                    before = original.read(file_path)
                    after = bundle.read("经审核材料/"+file_path)
                    if file_path.endswith(".docx"):
                        paragraphs = lambda data: [p.text for p in Document(BytesIO(data)).paragraphs]
                        before_lines, after_lines = paragraphs(before), paragraphs(after)
                        assert checksum(after) == checksum((EVIDENCE/"设备预约台－逐件下载.docx").read_bytes())
                        with ZipFile(BytesIO(before)) as before_zip, ZipFile(BytesIO(after)) as after_zip:
                            assert set(before_zip.namelist()) == set(after_zip.namelist())
                            assert {member for member in before_zip.namelist() if before_zip.read(member) != after_zip.read(member)} == {"word/document.xml"}
                    else:
                        before_lines, after_lines = before.decode().splitlines(), after.decode().splitlines()
                        field = next(line for line in after_lines if line.startswith("主要功能"))
                        assert "批量预约" in field and "短信提醒" not in field
                    expected = before_lines.copy()
                    for item in changes:
                        if item["path"] == file_path:
                            assert before_lines[item["index"]] == item["before"]
                            expected[item["index"]] = item["after"]
                    assert expected == after_lines
                result.update(check_source(bundle,receipt,original,1,draft=True))
            result.update({"actualEdits":4,"manualPdfPages":len(manual_pdf.pages)})
        if name == "microblog":
            assert len([issue for issue in receipt["issues"] if issue["id"] == "R5"]) == 2
            assert any(issue["id"]=="R6" and "第 3 页" not in issue["location"] and "软件概述" in issue["detail"] for issue in receipt["issues"])
            assert "manual.pdf" in receipt["blocked"] and len(receipt["blocked"]) == 3
            with ZipFile(micro_archive) as original:
                result.update(check_source(bundle,receipt,original,33))
        if name in {"hollowBefore","hollow"}:
            source = PdfReader(BytesIO(target(bundle,receipt,"historical-source-original")))
            assert len(source.pages)==29 and all(page.extract_text().strip() for page in source.pages)
            result.update({"historicalSourcePages":len(source.pages)})
        if name == "hollow":
            corrected = target(bundle,receipt,"historical-reviewed-manual")
            doc = PdfReader(BytesIO(corrected))
            assert len(doc.pages)==20
            assert "中途缺号会提前结束" in doc.pages[18].extract_text().replace(" ","")
            annotations = [ref.get_object() for ref in doc.pages[0]["/Annots"]]
            destinations = [item["/Dest"].get_object()[0] for item in annotations if item["/Subtype"]=="/Link"]
            assert len(destinations)==26 and {ref.idnum for ref in destinations} <= {page.indirect_reference.idnum for page in doc.pages[1:]}
            result.update({"historicalManualPages":len(doc.pages),"directoryLinks":len(destinations)})
        if name == "weak":
            assert RUNS[name]["staleDownloadRejected"]
            draft = next(item["file"] for item in receipt["drafts"] if item["file"]["kind"]=="filing-manual")
            assert checksum(bundle.read("待核草稿/" + draft["path"])) == draft["hash"]
        if name == "long":
            assert RUNS[name]["directoryUpload"]
            inputs = read_json(bundle,"输入清单.json")["entries"]
            assert any(file["path"] == "研发/发布版/reservation-data.py" and "container" not in file for file in inputs)
            assert not any(".workspace-marker" in file["path"] for file in inputs)
            with ZipFile(device_archive) as original:
                result.update(check_source(bundle,receipt,original,None,synthetic=True))
        observed[name] = result

lifecycle = RUNS["deviceLifecycle"]
assert lifecycle["restarted"] and lifecycle["reuploadEdits"] == 0 and lifecycle["tampered"] == [409,409]
assert lifecycle["oldIndividualRefused"] and len(lifecycle["conflict"]) >= 2
for path, fingerprint in BROWSER["fileHashes"].items():
    assert checksum((EVIDENCE / path).read_bytes()) == fingerprint
(EVIDENCE / "verified-downloads.json").write_text(json.dumps(
    {"verified":True,"actualDownloads":observed,"deviceLifecycle":lifecycle},
    ensure_ascii=False,indent=2),encoding="utf-8")
print("实际下载件独立核验通过。")
