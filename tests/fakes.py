from app.jira_client import JiraUnavailableError

FIELDS = [
    {"id": "issuekey", "name": "Key", "custom": False, "searchable": False, "clauseNames": ["key", "issuekey"], "schema": None},
    {"id": "summary", "name": "Summary", "custom": False, "searchable": True, "clauseNames": ["summary"], "schema": {"type": "string"}},
    {"id": "status", "name": "Status", "custom": False, "searchable": True, "clauseNames": ["status"], "schema": {"type": "status"}},
    {"id": "assignee", "name": "Assignee", "custom": False, "searchable": True, "clauseNames": ["assignee"], "schema": {"type": "user"}},
    {"id": "labels", "name": "Labels", "custom": False, "searchable": True, "clauseNames": ["labels"], "schema": {"type": "array", "items": "string"}},
    {"id": "created", "name": "Created", "custom": False, "searchable": True, "clauseNames": ["created", "createdDate"], "schema": {"type": "datetime"}},
    {"id": "comment", "name": "Comment", "custom": False, "searchable": True, "clauseNames": ["comment"], "schema": {"type": "comments-page"}},
    {"id": "fixVersions", "name": "Fix Version/s", "custom": False, "searchable": True, "clauseNames": ["fixVersion"], "schema": {"type": "array", "items": "version"}},
    {"id": "customfield_10111", "name": "Story Points", "custom": True, "searchable": True, "clauseNames": ["cf[10111]", "Story Points"], "schema": {"type": "number", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float"}},
    {"id": "customfield_10020", "name": "Sprint", "custom": True, "searchable": True, "clauseNames": ["cf[10020]", "Sprint"],
     "schema": {"type": "array", "items": "string", "custom": "com.pyxis.greenhopper.jira:gh-sprint"}},
]


def make_issues(n: int, start: int = 1) -> list[dict]:
    return [
        {"key": f"ABC-{i}", "fields": {"summary": f"Task {i}", "status": {"name": "Done"},
                                       "created": "2024-05-01T10:15:30.000+0700"}}
        for i in range(start, start + n)
    ]


class FakeClient:
    """Stands in for JiraClient; serves `total` issues in pages."""

    def __init__(self, total: int = 0, fail_on_call: int | None = None):
        self.total = total
        self.fail_on_call = fail_on_call
        self.search_calls: list[dict] = []

    async def aclose(self):
        pass

    async def myself(self):
        return {"name": "me", "displayName": "Me"}

    async def fields(self):
        return FIELDS

    async def projects(self):
        return [{"key": "ABC", "name": "Alpha"}]

    async def statuses(self):
        return [
            {"name": "Done", "statusCategory": {"key": "done"}},
            {"name": "Done", "statusCategory": {"key": "done"}},
            {"name": "Open", "statusCategory": {"key": "new"}},
        ]

    async def issue_types(self):
        return [{"name": "Bug"}]

    async def labels(self, q):
        return ["bug"]

    async def users(self, q):
        return [{"name": "alice", "displayName": "Alice"}]

    async def groups(self, q):
        return ["backend", "frontend"]

    async def suggest(self, clause, q):
        return [f"{clause}-value"]

    async def latest_comment(self, key):
        return {"author": {"displayName": "Zed"}, "created": "2024-06-01T09:00:00.000+0700", "body": f"newest for {key}"}

    async def boards(self, key):
        return [{"id": 1, "name": "Board"}]

    async def sprints(self, board_id):
        return [{"id": 7, "name": "Sprint 7", "state": "active"}]

    async def search(self, jql, fields, start_at, max_results):
        self.search_calls.append({"jql": jql, "fields": fields, "start_at": start_at, "max_results": max_results})
        if self.fail_on_call is not None and len(self.search_calls) == self.fail_on_call:
            raise JiraUnavailableError("HTTP 503")
        count = max(0, min(max_results, self.total - start_at))
        return {"total": self.total, "issues": make_issues(count, start_at + 1)}
