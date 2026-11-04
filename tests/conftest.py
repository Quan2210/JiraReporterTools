import pytest

from app.config import Settings

FAKE_PAT = "SECRET-PAT-VALUE-123"
BASE = "https://jira.test"


@pytest.fixture
def settings() -> Settings:
    return Settings(jira_base_url=BASE, jira_pat=FAKE_PAT, max_rows=250, page_size=100)
