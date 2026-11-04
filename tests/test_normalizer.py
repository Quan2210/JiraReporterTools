from app.normalizer import (
    COMMENT_MAX_CHARS, comment_page_truncated, format_comment, latest_comment, normalize_issue, normalize_value,
)

SPRINT_META = {"id": "customfield_10020", "schema": {"type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint"}}
DATE_META = {"id": "created", "schema": {"type": "datetime"}}
COMMENT_META = {"id": "comment", "schema": {"type": "comments-page"}}
LABELS_META = {"id": "labels", "schema": {"type": "array", "items": "string"}}


def test_none_and_scalars():
    assert normalize_value(None, None) == ""
    assert normalize_value(5, None) == "5"
    assert normalize_value(True, None) == "true"
    assert normalize_value("text", None) == "text"


def test_user_and_named_objects():
    assert normalize_value({"displayName": "Alice", "name": "alice"}, None) == "Alice"
    assert normalize_value({"name": "In Progress", "id": "3"}, None) == "In Progress"
    assert normalize_value({"value": "High"}, None) == "High"


def test_list_joined_and_empty_items_skipped():
    assert normalize_value(["a", "b"], None) == "a, b"
    assert normalize_value([{"name": "x"}, None, {"name": "y"}], None) == "x, y"
    assert normalize_value([], None) == ""


def test_unknown_dict_falls_back_to_json():
    assert normalize_value({"foo": "bar"}, None) == '{"foo": "bar"}'


def test_datetime_formatted():
    assert normalize_value("2024-05-01T10:15:30.000+0700", DATE_META) == "01/05/2024 10:15"


def test_sprint_real_jira_server_format():
    raw = ["com.atlassian.greenhopper.service.sprint.Sprint@2d27277d[activatedDate=2026-03-26T12:49:27.452+08:00,"
           "autoStartStop=false,goal=<null>,id=148,incompleteIssuesDestinationId=<null>,name=F2C Sprint 5,"
           "rapidViewId=150,sequence=148,startDate=2026-03-26T09:00:00.000+08:00,state=CLOSED,synced=false]"]
    assert normalize_value(raw, SPRINT_META) == "F2C Sprint 5"


def test_sprint_name_with_comma_and_multiple():
    raw = [
        "x.Sprint@1[id=1,state=CLOSED,name=Sprint 1, phase A,startDate=2024]",
        "x.Sprint@2[id=2,state=ACTIVE,name=Sprint 2,goal=]",
    ]
    assert normalize_value(raw, SPRINT_META) == "Sprint 1, phase A, Sprint 2"


def test_sprint_dict_format_and_unparseable():
    assert normalize_value([{"id": 1, "name": "Sprint 9"}], SPRINT_META) == "Sprint 9"
    assert normalize_value(["weird"], SPRINT_META) == "weird"


# ---- comments -------------------------------------------------------------

def _c(created, body, author="Alice"):
    return {"author": {"displayName": author}, "created": created, "body": body}


def test_comment_shows_newest_regardless_of_array_order():
    page = {"total": 2, "comments": [_c("2024-06-02T10:00:00.000+0700", "new"), _c("2024-06-01T10:00:00.000+0700", "old")]}
    assert normalize_value(page, COMMENT_META) == "Alice (02/06/2024 10:00): new"


def test_comment_is_single_line_and_truncated():
    body = "line1\n\n  line2 " + "x" * 800
    text = format_comment(_c("2024-06-01T10:00:00.000+0700", body))
    assert "\n" not in text
    assert text.startswith("Alice (01/06/2024 10:00): line1 line2 xxx")
    assert text.endswith("…")
    assert len(text.split(": ", 1)[1]) == COMMENT_MAX_CHARS


def test_comment_empty_and_missing_author():
    assert normalize_value({"total": 0, "comments": []}, COMMENT_META) == ""
    assert normalize_value(None, COMMENT_META) == ""
    assert format_comment({"created": "", "body": "só text"}) == "só text"


def test_latest_comment_and_truncation_detection():
    assert latest_comment({"comments": []}) is None
    assert comment_page_truncated({"total": 5, "comments": [_c("x", "y")]}) is True
    assert comment_page_truncated({"total": 1, "comments": [_c("x", "y")]}) is False
    assert comment_page_truncated(None) is False


# ---- issue rows -----------------------------------------------------------

def test_issue_row_shape_and_url():
    issue = {"key": "ABC-1", "fields": {"summary": "Hi", "status": {"name": "Done"}, "labels": ["a", "b, c"],
                                        "customfield_10020": ["x.Sprint@1[id=1,name=S1,state=ACTIVE]"]}}
    meta = {"labels": LABELS_META, "customfield_10020": SPRINT_META}
    row = normalize_issue(issue, ["issuekey", "summary", "labels", "customfield_10020"], meta, "https://jira.test")
    assert row["key"] == "ABC-1" and row["url"] == "https://jira.test/browse/ABC-1"
    assert row["summary"] == "Hi" and row["status"] == "Done"
    assert list(row["cells"]) == ["issuekey", "summary", "labels", "customfield_10020"]
    assert row["cells"]["labels"] == "a, b, c"
    assert row["atoms"] == {"labels": ["a", "b, c"], "customfield_10020": ["S1"]}


def test_row_url_only_for_valid_keys():
    row = normalize_issue({"key": "../etc", "fields": {}}, ["summary"], {}, "https://jira.test")
    assert row["url"] is None
    assert normalize_issue({"key": "ABC-1", "fields": {}}, ["summary"], {})["url"] is None


def test_issue_without_selected_columns_still_has_summary_and_status():
    row = normalize_issue({"key": "ABC-2", "fields": {"summary": "S", "status": {"name": "Open"}}}, ["issuekey"], {})
    assert row["summary"] == "S" and row["status"] == "Open" and row["cells"] == {"issuekey": "ABC-2"}


# ---- dates: dd/MM/yyyy for display, ISO kept for sorting/grouping ----------------

DATEONLY_META = {"id": "duedate", "schema": {"type": "date"}}


def test_date_only_field_is_dd_mm_yyyy():
    assert normalize_value("2024-05-01", DATEONLY_META) == "01/05/2024"


def test_datetime_without_time_part_has_no_time():
    assert normalize_value("2024-05-01", DATE_META) == "01/05/2024"


def test_unparseable_dates_are_left_alone():
    assert normalize_value("soon", DATE_META) == "soon"
    assert normalize_value("soon", DATEONLY_META) == "soon"


def test_row_keeps_iso_raw_for_date_columns_only():
    issue = {"key": "A-1", "fields": {"created": "2026-10-01T09:09:00.000+0800", "duedate": "2026-11-05", "summary": "x"}}
    meta = {"created": DATE_META, "duedate": DATEONLY_META}
    row = normalize_issue(issue, ["created", "duedate", "summary"], meta)
    assert row["cells"] == {"created": "01/10/2026 09:09", "duedate": "05/11/2026", "summary": "x"}
    assert row["raw"] == {"created": "2026-10-01T09:09", "duedate": "2026-11-05"}


def test_empty_date_has_no_raw():
    row = normalize_issue({"key": "A-1", "fields": {"created": None}}, ["created"], {"created": DATE_META})
    assert row["cells"]["created"] == "" and row["raw"] == {}
