import pytest

from app.config import Settings

FAKE_PAT = "SECRET-PAT-VALUE-123"
BASE = "https://jira.test"


@pytest.fixture
def settings() -> Settings:
    return Settings(jira_base_url=BASE, jira_pat=FAKE_PAT, max_rows=250, page_size=100)


@pytest.fixture(autouse=True)
def _isolated_app_defaults(monkeypatch, tmp_path):
    """Tests never touch the real data/ folder, and TestClient's Host ("testserver") passes the loopback guard."""
    import app.main as main
    import app.reminder_service as reminder_service
    monkeypatch.setattr(reminder_service, "RETRY_DELAY_SECONDS", 0)
    monkeypatch.setattr(main, "DEFAULT_DB_PATH", tmp_path / "reminders.db")
    monkeypatch.setattr(main, "DEFAULT_ALLOWED_HOSTS", main.DEFAULT_ALLOWED_HOSTS | {"testserver"})


SLACK_URL = "https://hooks.slack.com/services/T000/B000/SECRETSLACKPART"
TG_TOKEN = "123456:SECRET-TELEGRAM-TOKEN"


@pytest.fixture
def ch_settings() -> Settings:
    return Settings(jira_base_url=BASE, jira_pat=FAKE_PAT, max_rows=250, page_size=100,
                    slack_webhook_url=SLACK_URL, telegram_bot_token=TG_TOKEN)
