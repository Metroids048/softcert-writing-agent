"""Preserve source symbols while retaining the pinned renderer's page layout."""
import argparse
from os import environ
from pathlib import Path
import re

from pypdf import PdfReader
from reportlab.pdfbase import pdfmetrics, ttfonts
import render_code_pdf as render


SYMBOL_FONTS = {
    'SoftCertSymbols': 'NotoEmoji.ttf',
    'SoftCertSupplementarySymbols': 'NotoSansSymbols2-Regular.ttf',
}
FILING = 'SoftCertFilingFallback'
upstream_unicode_map = ttfonts.makeToUnicodeCMap


def unicode_map(font_name, subset):
    cmap = upstream_unicode_map(font_name, subset)
    for code, scalar in enumerate(subset):
        if scalar > 0xFFFF:
            utf16 = chr(scalar).encode('utf-16-be').hex().upper()
            cmap = cmap.replace(f'<{code:02X}> <{scalar:04X}>', f'<{code:02X}> <{utf16}>')
    return cmap


def glyph_runs(line, narrow, wide):
    runs = []
    for character in line:
        fonts = (wide, narrow) if render.char_columns(character) == 2 else (narrow, wide)
        font = next((name for name in (*fonts, *SYMBOL_FONTS)
                     if pdfmetrics.getFont(name).face.charToGlyph.get(ord(character))), None)
        if font is None and (filename := environ.get('SOFTCERT_SOURCE_FILING_FONT')):
            if FILING not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(ttfonts.TTFont(FILING, filename))
            if pdfmetrics.getFont(FILING).face.charToGlyph.get(ord(character)):
                font = FILING
        if font is None:
            raise ValueError(f'当前字体无法还原源码字符 U+{ord(character):04X}')
        if runs and runs[-1][0] == font:
            runs[-1][1].append(character)
        else:
            runs.append((font, [character]))
    return [(font, ''.join(characters)) for font, characters in runs]


def compact(text):
    return re.sub(r'\s+', '', text)


def verify_rendered_volume():
    parser = argparse.ArgumentParser(add_help=False)
    for name in ('provenance', 'facts', 'pdf'):
        parser.add_argument(f'--{name}', required=True, type=Path)
    parser.add_argument('--volume', required=True)
    args, _ = parser.parse_known_args()
    source = render.load_json(args.provenance)
    facts = render.load_json(args.facts)
    input_path = Path(source['artifacts'][f'{args.volume}_txt']['path'])
    pages = render.parse_pages(input_path)
    page_start = 31 if args.volume == 'back_30' else 1
    for number, (pdf_page, lines) in enumerate(zip(PdfReader(args.pdf).pages, pages, strict=True), page_start):
        header = facts['software_full_name'] + facts['version'] + f'第{number}页'
        if compact(pdf_page.extract_text()) != compact(header + ''.join(lines)):
            raise ValueError(f'第 {number} 页的 PDF 正文无法与排版源码逐行对应')


if __name__ == '__main__':
    for name, filename in SYMBOL_FONTS.items():
        pdfmetrics.registerFont(ttfonts.TTFont(name, str(Path(__file__).with_name(filename))))
    ttfonts.makeToUnicodeCMap = unicode_map
    render.line_runs = glyph_runs
    status = render.main()
    if not status:
        verify_rendered_volume()
    raise SystemExit(status)
