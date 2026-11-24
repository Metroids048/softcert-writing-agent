"""Create an editable Word copy from the same draft used by the workbench."""
import re
import sys
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches, Pt


def write(source, output, illustrations):
    document = Document()
    for name in ("Normal", "List Bullet", "Title", "Heading 1", "Heading 2"):
        style = document.styles[name]
        style.font.name = "Arial Unicode MS"
        fonts = style.element.get_or_add_rPr().rFonts
        for attribute in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
            fonts.attrib.pop(qn("w:" + attribute), None)
        fonts.set(qn("w:eastAsia"), "Arial Unicode MS")
    document.styles["Normal"].font.size = Pt(11)
    images = iter(illustrations)
    for line in Path(source).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        heading = re.match(r"^(#{1,3}) (.+)$", line)
        text = (heading[2] if heading else line.removeprefix("- ")).replace("`", "")
        if heading:
            document.add_heading(text, level=len(heading[1]) - 1)
        else:
            document.add_paragraph(text, style="List Bullet" if line.startswith("- ") else None)
        if re.match(r"^实操截图 \d+：", line):
            document.add_picture(next(images), width=Inches(5.1))
    if next(images, None) is not None:
        raise ValueError("Word 图示未对应实际操作。")
    document.save(output)


if __name__ == "__main__":
    write(sys.argv[1], sys.argv[2], sys.argv[3:])
