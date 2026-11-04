import csv
import io
import re

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_MAX_COL_WIDTH = 60
HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _guard(text: str) -> str:
    """Neutralise spreadsheet formula injection from untrusted Jira content."""
    if text and text.startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


def text_color_for(background: str) -> str:
    """Black or white text, whichever contrasts better with the given #RRGGBB background."""
    r, g, b = (int(background[i : i + 2], 16) for i in (1, 3, 5))
    luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return "000000" if luminance > 0.55 else "FFFFFF"


def to_csv(headers: list[str], rows: list[list[str]]) -> bytes:
    buf = io.StringIO(newline="")
    writer = csv.writer(buf)
    writer.writerow([_guard(h) for h in headers])
    for row in rows:
        writer.writerow([_guard(c) for c in row])
    # UTF-8 BOM so Excel detects the encoding (Vietnamese text)
    return buf.getvalue().encode("utf-8-sig")


def to_xlsx(headers: list[str], rows: list[list[str]], fills: list[list[str | None]] | None = None) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Report"
    clean = lambda s: ILLEGAL_CHARACTERS_RE.sub("", _guard(s))  # noqa: E731
    ws.append([clean(h) for h in headers])
    for row in rows:
        ws.append([clean(c) for c in row])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    if fills:
        for r_idx, fill_row in enumerate(fills, start=2):
            for c_idx, color in enumerate(fill_row, start=1):
                if color and HEX_COLOR_RE.match(color):
                    cell = ws.cell(row=r_idx, column=c_idx)
                    cell.fill = PatternFill("solid", start_color=color[1:].upper(), end_color=color[1:].upper())
                    cell.font = Font(color=text_color_for(color))
    ws.freeze_panes = "A2"
    if headers:
        ws.auto_filter.ref = ws.dimensions
    for idx, header in enumerate(headers, start=1):
        longest = max([len(header)] + [len(r[idx - 1]) for r in rows if idx - 1 < len(r)])
        ws.column_dimensions[get_column_letter(idx)].width = min(max(longest + 2, 8), _MAX_COL_WIDTH)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
