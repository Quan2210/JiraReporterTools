import csv
import io

from openpyxl import load_workbook

from app.exporter import to_csv, to_xlsx

HEADERS = ["Key", "Summary"]
ROWS = [["ABC-1", "Lỗi giao diện"], ["ABC-2", "=HYPERLINK(\"http://evil\")"], ["ABC-3", "line1\nline2, with comma"]]


def test_csv_has_bom_and_roundtrips_unicode():
    data = to_csv(HEADERS, ROWS)
    assert data.startswith(b"\xef\xbb\xbf")
    parsed = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
    assert parsed[0] == HEADERS
    assert parsed[1] == ["ABC-1", "Lỗi giao diện"]
    assert parsed[3] == ["ABC-3", "line1\nline2, with comma"]


def test_csv_neutralises_formulas():
    parsed = list(csv.reader(io.StringIO(to_csv(HEADERS, ROWS).decode("utf-8-sig"))))
    assert parsed[2][1].startswith("'=")


def test_xlsx_content_and_header():
    ws = load_workbook(io.BytesIO(to_xlsx(HEADERS, ROWS))).active
    values = [[c.value for c in row] for row in ws.iter_rows()]
    assert values[0] == HEADERS
    assert len(values) == 1 + len(ROWS)
    assert values[1] == ["ABC-1", "Lỗi giao diện"]
    assert ws["A1"].font.bold
    assert ws.freeze_panes == "A2"


def test_xlsx_neutralises_formulas_and_strips_illegal_chars():
    ws = load_workbook(io.BytesIO(to_xlsx(HEADERS, [["K", "=1+1"], ["K2", "bad\x00char"]]))).active
    assert ws["B2"].value == "'=1+1"
    assert ws["B3"].value == "badchar"


def test_xlsx_empty_rows():
    ws = load_workbook(io.BytesIO(to_xlsx(HEADERS, []))).active
    assert [c.value for c in ws[1]] == HEADERS


def test_xlsx_fills_apply_background_and_contrasting_text():
    rows = [["K", "dark"], ["K2", "light"]]
    fills = [["#1F3A5F", None], [None, "#FFF2CC"]]
    ws = load_workbook(io.BytesIO(to_xlsx(HEADERS, rows, fills))).active
    assert ws["A2"].fill.start_color.rgb.endswith("1F3A5F")
    assert ws["A2"].font.color.rgb.endswith("FFFFFF")      # white text on dark fill
    assert ws["B3"].fill.start_color.rgb.endswith("FFF2CC")
    assert ws["B3"].font.color.rgb.endswith("000000")      # black text on light fill
    assert ws["B2"].fill.fill_type is None


def test_xlsx_ignores_invalid_fill_values():
    ws = load_workbook(io.BytesIO(to_xlsx(HEADERS, [["a", "b"]], [["javascript:x", "#12"]]))).active
    assert ws["A2"].fill.fill_type is None and ws["B2"].fill.fill_type is None


def test_text_color_for_extremes():
    from app.exporter import text_color_for
    assert text_color_for("#000000") == "FFFFFF"
    assert text_color_for("#FFFFFF") == "000000"
