import logging
from pathlib import Path

import httpx
import respx
from fastapi.testclient import TestClient

from app.config import ConfigError, Settings
from app.jira_client import JiraClient
from app.main import create_app
from tests.conftest import BASE, FAKE_PAT

ROOT = Path(__file__).resolve().parent.parent


def test_settings_repr_hides_pat(settings):
    assert FAKE_PAT not in repr(settings)


def test_static_files_do_not_contain_pat_or_env_values():
    files = [p for p in (ROOT / "static").rglob("*") if p.is_file()]
    assert any(p.suffix == ".js" for p in files)          # the module sub-folders are really covered
    for path in files:
        data = path.read_bytes()      # also covers binary assets (icons, video)
        assert FAKE_PAT.encode() not in data
        assert b"JIRA_PAT" not in data


def test_missing_config_fails_fast(monkeypatch):
    monkeypatch.setattr("app.config.load_dotenv", lambda: None)
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_PAT", raising=False)
    try:
        Settings.from_env()
    except ConfigError as exc:
        assert "JIRA_PAT" in str(exc) and "JIRA_BASE_URL" in str(exc)
    else:
        raise AssertionError("expected ConfigError")


@respx.mock
def test_pat_never_in_responses_or_logs(settings, caplog):
    respx.get(f"{BASE}/rest/api/2/myself").mock(return_value=httpx.Response(503))
    app = create_app(settings=settings, client=JiraClient(settings))
    with caplog.at_level(logging.DEBUG), TestClient(app) as c:
        r = c.get("/api/health")
    assert r.status_code == 502
    assert FAKE_PAT not in r.text
    assert FAKE_PAT not in caplog.text
    assert FAKE_PAT not in str(r.headers)


def test_server_binds_loopback_only():
    source = (ROOT / "run.py").read_text(encoding="utf-8")
    assert 'host="127.0.0.1"' in source
    assert "0.0.0.0" not in source


def test_no_cors_middleware(settings):
    from tests.fakes import FakeClient
    app = create_app(settings=settings, client=FakeClient())
    with TestClient(app) as c:
        r = c.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_export_endpoint_never_contacts_jira_and_ignores_pat(settings):
    from tests.fakes import FakeClient
    fake = FakeClient()
    with TestClient(create_app(settings=settings, client=fake)) as c:
        r = c.post("/api/export?format=csv", json={"headers": ["a"], "rows": [["=cmd|' /C calc'!A0"]]})
    assert r.status_code == 200
    assert fake.search_calls == []
    assert FAKE_PAT not in r.text
    assert "'=cmd" in r.content.decode("utf-8-sig")        # formula neutralised


def test_base_url_must_have_scheme(monkeypatch):
    monkeypatch.setattr("app.config.load_dotenv", lambda: None)
    monkeypatch.setenv("JIRA_BASE_URL", "jira.example.com")
    monkeypatch.setenv("JIRA_PAT", "x")
    try:
        Settings.from_env()
    except ConfigError as exc:
        assert "JIRA_BASE_URL" in str(exc)
    else:
        raise AssertionError("expected ConfigError")
