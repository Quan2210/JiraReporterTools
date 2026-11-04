"""Run the UI against fake Jira data (no network, no PAT):  python -m tests.dev_server

For manual / browser verification only; it is not part of the product.
"""
import os
import random

import uvicorn

from app.config import Settings
from app.main import create_app
from tests.fakes import FIELDS, FakeClient

EXTRA_FIELDS = [
    {"id": "reporter", "name": "Reporter", "custom": False, "searchable": True, "clauseNames": ["reporter"], "schema": {"type": "user"}},
    {"id": "updated", "name": "Updated", "custom": False, "searchable": True, "clauseNames": ["updated"], "schema": {"type": "datetime"}},
    {"id": "issuetype", "name": "Issue Type", "custom": False, "searchable": True, "clauseNames": ["issuetype"], "schema": {"type": "issuetype"}},
]
STATUSES = [("Open", "new"), ("In Progress", "indeterminate"), ("Resolved", "indeterminate"), ("Closed", "done")]
PEOPLE = ["An Nguyen", "Binh Tran", "Chi Le", None]
LABELS = ["bug", "backend", "ui", "urgent", "tech-debt"]


def make_issue(i: int) -> dict:
    rnd = random.Random(i)
    day = 1 + i % 9
    comments = [
        {"author": {"displayName": rnd.choice(PEOPLE[:3])}, "created": f"2026-10-{day:02d}T0{n}:10:00.000+0800",
         "body": f"Comment {n} on task {i}\nwith a second line " + "long text " * rnd.randint(1, 30)}
        for n in range(rnd.randint(0, 4))
    ]
    return {"key": f"ABC-{i}", "fields": {
        "summary": f"Task number {i} {'<b>x</b>' if i % 7 == 0 else ''}",
        "status": {"name": rnd.choice(STATUSES)[0]},
        "assignee": ({"displayName": a} if (a := rnd.choice(PEOPLE)) else None),
        "reporter": {"displayName": rnd.choice(PEOPLE[:3])},
        "labels": rnd.sample(LABELS, rnd.randint(0, 3)),
        "created": f"2026-10-{day:02d}T09:{i % 60:02d}:00.000+0800",
        "updated": f"2026-10-{min(day + 2, 28):02d}T10:00:00.000+0800",
        "customfield_10111": rnd.choice([None, 1, 2, 3, 5, 8]),
        "customfield_10020": [f"x.Sprint@1[id={7 + i % 2},state=ACTIVE,name=Sprint {7 + i % 2},goal=]"],
        "comment": {"total": len(comments), "comments": comments},
        "issuetype": {"name": rnd.choice(["Bug", "Task", "Story"])},
    }}


class DevClient(FakeClient):
    async def fields(self):
        return FIELDS + EXTRA_FIELDS

    async def statuses(self):
        return [{"name": n, "statusCategory": {"key": c}} for n, c in STATUSES]

    async def users(self, q):
        return [{"name": n.split()[0].lower(), "displayName": n} for n in PEOPLE[:3] if q.lower() in n.lower()]

    async def labels(self, q):
        return [l for l in LABELS if q.lower() in l]

    async def search(self, jql, fields, start_at, max_results):
        self.search_calls.append({"jql": jql})
        total = 123
        count = max(0, min(max_results, total - start_at))
        return {"total": total, "issues": [make_issue(i) for i in range(start_at + 1, start_at + count + 1)]}


if __name__ == "__main__":
    settings = Settings(jira_base_url="https://jira.example.test", jira_pat="dev-only", max_rows=5000, page_size=100)
    uvicorn.run(create_app(settings=settings, client=DevClient(total=123)), host="127.0.0.1", port=int(os.getenv("DEV_PORT", "8766")))
