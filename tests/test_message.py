from app.message import render_line

ROW = {"key": "ABC-1", "summary": "Fix\nlogin  bug", "status": "Done", "url": "https://j/browse/ABC-1"}


def test_fills_known_placeholders_and_flattens_newlines():
    assert render_line("{key}: {summary} [{status}] {url}", ROW) == "ABC-1: Fix login  bug [Done] https://j/browse/ABC-1"


def test_unknown_placeholder_left_as_written():
    assert render_line("{key} {nope}", ROW) == "ABC-1 {nope}"


def test_note_is_empty_server_side():
    assert render_line("{key} ==> {note}", ROW) == "ABC-1 ==> "


def test_missing_url_is_empty():
    assert render_line("{key}{url}", {"key": "A-1", "url": None}) == "A-1"
