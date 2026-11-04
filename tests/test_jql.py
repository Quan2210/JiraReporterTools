from datetime import date

import pytest
from pydantic import ValidationError

from app.jql import JqlError, build_jql, quote
from app.schemas import ReportQuery
from tests.fakes import FIELDS

META = {f["id"]: f for f in FIELDS}


def q(**kw) -> ReportQuery:
    kw.setdefault("columns", ["summary"])
    return ReportQuery(**kw)


def cf(field_id, operator, *values):
    return {"field_id": field_id, "operator": operator, "values": list(values)}


def test_empty_filters_only_orders():
    assert build_jql(q()) == "ORDER BY created DESC"


def test_all_filters_combined():
    jql = build_jql(q(
        projects=["ABC", "XYZ"], labels=["bug"], sprints=[12, 13], reporters=["alice"],
        created_from=date(2024, 1, 1), created_to=date(2024, 1, 31),
    ))
    assert jql == (
        'project in ("ABC", "XYZ") AND labels in ("bug") AND sprint in (12, 13) '
        'AND reporter in ("alice") AND created >= "2024-01-01" AND created < "2024-02-01" '
        "ORDER BY created DESC"
    )


def test_optional_filters():
    jql = build_jql(q(assignees=["bob"], statuses=["In Progress"], issue_types=["Bug"]))
    assert 'assignee in ("bob")' in jql
    assert 'status in ("In Progress")' in jql
    assert 'issuetype in ("Bug")' in jql


def test_updated_range_inclusive():
    jql = build_jql(q(updated_from=date(2024, 5, 1), updated_to=date(2024, 5, 31)))
    assert 'updated >= "2024-05-01"' in jql and 'updated < "2024-06-01"' in jql


def test_end_date_is_inclusive_across_month_boundary():
    assert 'created < "2025-01-01"' in build_jql(q(created_to=date(2024, 12, 31)))


# ---- groups ---------------------------------------------------------------

def test_group_only():
    assert build_jql(q(assignee_groups=["backend"])).startswith('assignee in membersOf("backend")')


def test_users_and_groups_combined_with_or_and_parentheses():
    jql = build_jql(q(assignees=["bob"], assignee_groups=["backend", "qa"]))
    assert jql.startswith('(assignee in ("bob") OR assignee in membersOf("backend") OR assignee in membersOf("qa"))')


def test_reporter_groups():
    assert 'reporter in membersOf("ops")' in build_jql(q(reporter_groups=["ops"]))


def test_group_name_is_quoted_against_injection():
    jql = build_jql(q(assignee_groups=['x") OR project = SECRET OR ("y']))
    assert 'membersOf("x\\") OR project = SECRET OR (\\"y")' in jql


# ---- custom filters -------------------------------------------------------

@pytest.mark.parametrize("flt,expected", [
    (cf("labels", "in", "a", "b"), 'labels in ("a", "b")'),
    (cf("labels", "not_in", "a"), 'labels not in ("a")'),
    (cf("summary", "contains", "lỗi đăng nhập"), 'summary ~ "lỗi đăng nhập"'),
    (cf("customfield_10111", "gte", "5"), "cf[10111] >= 5"),
    (cf("customfield_10111", "eq", "3.5"), "cf[10111] = 3.5"),
    (cf("customfield_10111", "empty"), "cf[10111] is EMPTY"),
    (cf("labels", "not_empty"), "labels is not EMPTY"),
    (cf("created", "lt", "2024-05-01"), 'created < "2024-05-01"'),
    (cf("fixVersions", "in", "1.0"), 'fixVersion in ("1.0")'),
])
def test_custom_filter_operators(flt, expected):
    assert expected in build_jql(q(custom_filters=[flt]), META)


def test_custom_filter_validation():
    with pytest.raises(JqlError):
        build_jql(q(custom_filters=[cf("customfield_10111", "gte", "abc")]), META)       # not a number
    with pytest.raises(JqlError):
        build_jql(q(custom_filters=[cf("created", "gte", "yesterday")]), META)           # not a date
    with pytest.raises(JqlError):
        build_jql(q(custom_filters=[cf("summary", "gt", "x")]), META)                     # ordered op on text
    with pytest.raises(JqlError):
        build_jql(q(custom_filters=[cf("nope", "eq", "x")]), META)                        # unknown field
    with pytest.raises(JqlError):
        build_jql(q(custom_filters=[cf("labels", "in", "a")]))                            # no metadata


def test_custom_filter_cannot_inject_through_value():
    jql = build_jql(q(custom_filters=[cf("summary", "contains", 'x" OR project = SECRET OR summary ~ "y')]), META)
    assert 'summary ~ "x\\" OR project = SECRET OR summary ~ \\"y"' in jql


def test_custom_filter_schema_rules():
    with pytest.raises(ValidationError):
        q(custom_filters=[{"field_id": "labels", "operator": "in", "values": []}])
    with pytest.raises(ValidationError):
        q(custom_filters=[{"field_id": "labels", "operator": "eq", "values": ["a", "b"]}])
    with pytest.raises(ValidationError):
        q(custom_filters=[{"field_id": 'x"; DROP', "operator": "eq", "values": ["a"]}])
    with pytest.raises(ValidationError):
        q(custom_filters=[{"field_id": "labels", "operator": "like", "values": ["a"]}])


# ---- JQL mode -------------------------------------------------------------

def test_jql_mode_used_verbatim_and_ignores_filters():
    jql = build_jql(q(jql="  assignee = currentUser() ORDER BY updated DESC ", projects=["ABC"], labels=["x"]))
    assert jql == "assignee = currentUser() ORDER BY updated DESC"


def test_blank_jql_falls_back_to_filters():
    assert build_jql(q(jql="   ", projects=["ABC"])).startswith('project in ("ABC")')


def test_jql_limits():
    with pytest.raises(ValidationError):
        q(jql="x" * 5001)
    with pytest.raises(ValidationError):
        q(jql="a\x00b")


# ---- quoting / validation (unchanged behaviour) ---------------------------

def test_quote_escapes_quote_and_backslash():
    assert quote('a"b\\c') == '"a\\"b\\\\c"'


def test_quote_keeps_unicode():
    assert quote("lỗi giao diện") == '"lỗi giao diện"'


def test_injection_attempt_stays_inside_literal():
    jql = build_jql(q(labels=['x") OR project = SECRET OR labels in ("y']))
    assert jql.startswith('labels in ("x\\") OR project = SECRET OR labels in (\\"y")')


@pytest.mark.parametrize("bad", ["", "   ", "a\nb", "a\x00b", "x" * 300])
def test_quote_rejects_bad_values(bad):
    with pytest.raises(JqlError):
        quote(bad)


def test_non_numeric_sprint_rejected():
    with pytest.raises(ValidationError):
        q(sprints=["1) OR (1=1"])


def test_bad_project_key_rejected():
    with pytest.raises(ValidationError):
        q(projects=['A"B'])


def test_date_range_order_validated():
    with pytest.raises(ValidationError):
        q(created_from=date(2024, 2, 1), created_to=date(2024, 1, 1))
    with pytest.raises(ValidationError):
        q(updated_from=date(2024, 2, 1), updated_to=date(2024, 1, 1))


def test_columns_required():
    with pytest.raises(ValidationError):
        ReportQuery(columns=[])
