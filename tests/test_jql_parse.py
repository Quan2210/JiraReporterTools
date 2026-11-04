from datetime import date

from app.jql import build_jql
from app.jql_parse import parse_jql, split_clauses
from app.schemas import ReportQuery
from tests.fakes import FIELDS

META = {f["id"]: f for f in FIELDS}


def parse(jql):
    return parse_jql(jql, META)


def test_split_respects_quotes_parentheses_and_order_by():
    clauses, order = split_clauses('a = "x AND y" AND (b = 1 AND c = 2) AND d in ("p", "q") ORDER BY created DESC')
    assert clauses == ['a = "x AND y"', "(b = 1 AND c = 2)", 'd in ("p", "q")']
    assert order == "created DESC"


def test_split_handles_escaped_quotes():
    clauses, _ = split_clauses(r'summary ~ "say \"AND\" now" AND x = 1')
    assert clauses == [r'summary ~ "say \"AND\" now"', "x = 1"]


def test_supported_builtin_clauses():
    r = parse('project in ("ABC", XYZ) AND labels = bug AND sprint in (12, 13) AND status in ("In Progress") '
              'AND issuetype = Bug AND reporter in ("alice") ORDER BY created DESC')
    f = r["filters"]
    assert r["exact"] and r["unsupported"] == [] and r["order_by"] == "created DESC"
    assert f["projects"] == ["ABC", "XYZ"] and f["labels"] == ["bug"] and f["sprints"] == [12, 13]
    assert f["statuses"] == ["In Progress"] and f["issue_types"] == ["Bug"] and f["reporters"] == ["alice"]


def test_groups_and_users_for_assignee():
    r = parse('assignee in membersOf("backend") AND reporter in membersOf("qa")')
    assert r["filters"]["assignee_groups"] == ["backend"] and r["filters"]["reporter_groups"] == ["qa"]
    assert r["exact"]


def test_dates_inclusive_end():
    f = parse('created >= "2024-01-01" AND created < "2024-02-01" AND updated <= "2024-03-05"')["filters"]
    assert (f["created_from"], f["created_to"], f["updated_to"]) == ("2024-01-01", "2024-01-31", "2024-03-05")


def test_custom_filters_from_known_fields():
    f = parse('cf[10111] >= 5 AND Story Points != 2 AND summary ~ "login" AND fixVersion is EMPTY')["filters"]["custom_filters"]
    assert {"field_id": "customfield_10111", "operator": "gte", "values": ["5"]} in f
    assert {"field_id": "summary", "operator": "contains", "values": ["login"]} in f
    assert {"field_id": "fixVersions", "operator": "empty", "values": []} in f


def test_unsupported_parts_are_reported_not_guessed():
    r = parse('project = ABC AND (status = Open OR status = Closed) AND assignee = currentUser() AND foo = 1 '
              'AND sprint = "Sprint 5" AND created > "2024-01-01"')
    assert not r["exact"]
    assert r["filters"]["projects"] == ["ABC"]
    assert len(r["unsupported"]) == 5


def test_duplicate_builtin_clause_is_unsupported_not_merged():
    r = parse('project = A AND project = B')
    assert r["filters"]["projects"] == ["A"] and r["unsupported"] == ["project = B"]


def test_or_inside_value_is_rejected():
    r = parse("labels = a OR labels = b")
    assert not r["exact"] and r["filters"]["labels"] == []


def test_round_trip_build_parse_build():
    query = ReportQuery(
        columns=["summary"], projects=["ABC"], labels=["bug"], sprints=[7], reporters=["alice"],
        assignees=["bob"], statuses=["Open"], created_from=date(2024, 1, 1), created_to=date(2024, 1, 31),
        updated_from=date(2024, 2, 1),
        custom_filters=[{"field_id": "customfield_10111", "operator": "gte", "values": ["3"]}],
    )
    jql = build_jql(query, META)
    parsed = parse(jql)
    assert parsed["exact"]
    rebuilt = build_jql(ReportQuery(columns=["summary"], **parsed["filters"]), META)
    assert rebuilt == jql


def test_empty_values_and_garbage_do_not_crash():
    for text in ("", "   ", "((", '"', "a =", "= b", "project in (", 'labels in ("a'):
        parse_jql(text, META)
