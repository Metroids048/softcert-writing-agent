"""Paginate actual body lines and render the same rows to A4 PDF."""
import argparse
import json
import re
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from reportlab.lib.textsplit import wordSplit
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

from pagination import balanced_slices

SOURCE_REF = re.compile(r"〔[^〕]+〕")
SOURCE_LOCATION = re.compile(r"〔(.+) (第 .+)〕$")
FIGURE = re.compile(r"^实操截图 (\d+)：")


def draw_figures(canvas, figures, margin, width, height):
    if not figures:
        return
    gap = 8
    slot = (width - gap * (len(figures) - 1)) / len(figures)
    for index, (number, image) in enumerate(figures.items()):
        original_width, original_height = image.getSize()
        scale = min(slot / original_width, (height - 18) / original_height)
        image_width, image_height = original_width * scale, original_height * scale
        x = margin + index * (slot + gap) + (slot - image_width) / 2
        canvas.drawImage(image, x, margin + 12, image_width, image_height, mask="auto")
        canvas.setFont("Filing", 8)
        canvas.drawCentredString(x + image_width / 2, margin - 9, f"图 {number}")


def reference_names(markdown):
    paths = {match[1] for ref in SOURCE_REF.findall(markdown)
             if (match := SOURCE_LOCATION.match(ref))}
    names = {}
    for path in sorted(paths):
        parts = path.split("/")
        for count in range(1, len(parts) + 1):
            suffix = "/".join(parts[-count:])
            if not any(other != path and (other == suffix or other.endswith("/" + suffix)) for other in paths):
                names[path] = suffix
                break
    return names


def render(args):
    pdfmetrics.registerFont(TTFont("Filing", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"))
    width, height = A4
    margin = 53
    line_width = width - 2 * margin
    markdown = Path(args.markdown).read_text()
    names = reference_names(markdown)
    images = {index: ImageReader(path) for index, path in enumerate(args.illustrations, 1)}
    figure_marks = [int(match[1]) for line in markdown.splitlines() if (match := FIGURE.match(line))]
    if figure_marks != list(images):
        raise ValueError("说明书截图与动作顺序不符。")
    figure_height = 108 if images else 0
    blocks = []
    for line in markdown.splitlines():
        title = line.startswith("#")
        text = re.sub(r"^#{1,3} ", "", line)
        references = SOURCE_REF.findall(text)
        text = SOURCE_REF.sub("", text).strip()
        if not text or text.startswith(("软件全称：", "版本号：")):
            continue
        text = text.removeprefix("- ").replace("`", "")
        font_size = 14 if line.startswith("# ") else 12 if title else 11
        lines = [(content.strip(), font_size, not title) for _, content in
                 wordSplit(text, line_width, "Filing", font_size) if content.strip()]
        ref_text = " ".join(SOURCE_LOCATION.sub(
            lambda match: f"〔{names.get(match[1], match[1])} {match[2]}〕", ref) for ref in references)
        ref_rows = [(content.strip(), 8, False) for _, content in
                    wordSplit(ref_text, line_width, "Filing", 8) if content.strip()]
        if lines and references and pdfmetrics.stringWidth(lines[-1][0] + " " + ref_text, "Filing", font_size) <= line_width:
            content, size, body = lines[-1]
            lines[-1] = (content + " " + ref_text, size, body)
            ref_rows = []
        if re.search(r"来源为同包原件《[^》]+》物理第 \d+–\d+ 页（OCR 待校）。$", text):
            blocks.append(lines + ref_rows)
        elif lines and ref_rows:
            blocks.extend([row] for row in lines[:-1])
            blocks.append([lines[-1], *ref_rows])
        else:
            blocks.extend([row] for row in lines)

    occupied = [len(block) for block in blocks]
    eligible = [sum(row[2] for row in block) for block in blocks]
    body_top = height - (68 if images else 80)
    capacity, leading = int((body_top - margin - figure_height) / 14.75) + 1, 14.75
    sections = balanced_slices(occupied, 30, capacity, eligible)
    if sections is None:
        # Keep 11-point body text and use the remaining vertical space before splitting.
        compact_leading = 12.25 if images else 13.25
        compact_capacity = int((body_top - margin - figure_height) / compact_leading) + 1
        sections = balanced_slices(occupied, 30, compact_capacity, eligible)
        if sections is not None:
            capacity, leading = compact_capacity, compact_leading
    qualified = sections is not None
    pages = [[row for block in blocks[start:end] for row in block] for start, end in sections or []]
    if not pages:
        rows = [row for block in blocks for row in block]
        pages = [rows[i:i + capacity] for i in range(0, len(rows), capacity)]
    if not pages:
        raise ValueError("说明书没有可读正文。")
    full_count = len(pages)
    if full_count > 60:
        pages = [*pages[:30], *pages[-30:]]
    canvas = Canvas(args.output, pagesize=A4, pageCompression=1)
    canvas.setTitle(f"{args.name} {args.version} 说明书")
    counts = []
    figure_pages = []
    for number, rows in enumerate(pages, 1):
        stamp = f"{args.name}   {args.version}"
        canvas.setFont("Filing", min(9, 410 / pdfmetrics.stringWidth(stamp, "Filing", 1)))
        canvas.drawString(margin, height - 38, stamp)
        canvas.setFont("Filing", 9)
        canvas.drawRightString(width - margin, height - 38, f"第 {number} 页")
        for row, (text, size, _) in enumerate(rows):
            canvas.setFont("Filing", size)
            canvas.drawString(margin, body_top - leading * row, text)
        numbers = [int(match[1]) for text, _, _ in rows if (match := FIGURE.match(text))]
        draw_figures(canvas, {number: images[number] for number in numbers}, margin, line_width, figure_height)
        figure_pages.append(numbers)
        counts.append(sum(row[2] for row in rows))
        canvas.showPage()
    canvas.save()
    rendered = PdfReader(args.output, strict=True).pages
    if len(rendered) != len(pages) or any(args.version not in (page.extract_text() or "") for page in rendered):
        raise ValueError("说明书版次未能从实际 PDF 回读。")
    if any(sum(operator == b"Do" for _, operator in page.get_contents().operations) != len(figures)
           for page, figures in zip(rendered, figure_pages)):
        raise ValueError("说明书内嵌实操截图缺失。")
    print(json.dumps({"qualified": qualified, "bodyRows": counts, "fullPages": full_count, "figures": figure_pages}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for field in ("markdown", "output", "name", "version"):
        parser.add_argument(field)
    parser.add_argument("illustrations", nargs="*")
    render(parser.parse_args())
