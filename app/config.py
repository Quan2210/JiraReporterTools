import os
from dataclasses import dataclass, field

from dotenv import load_dotenv


SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/services/"


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    jira_base_url: str
    jira_pat: str = field(repr=False)
    max_rows: int = 5000
    page_size: int = 100
    port: int = 8000
    ca_bundle: str | None = None
    # Reminder channels. Both secrets live only in .env (the Slack webhook URL is itself a secret).
    slack_webhook_url: str | None = field(default=None, repr=False)
    telegram_bot_token: str | None = field(default=None, repr=False)
    reminder_catchup_minutes: int = 120
    reminder_history_days: int = 30

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        missing = [k for k in ("JIRA_BASE_URL", "JIRA_PAT") if not os.getenv(k, "").strip()]
        if missing:
            raise ConfigError(f"Thiếu biến cấu hình trong .env: {', '.join(missing)}")
        base_url = os.environ["JIRA_BASE_URL"].strip().rstrip("/")
        if not base_url.lower().startswith(("https://", "http://")):
            raise ConfigError("JIRA_BASE_URL phải bắt đầu bằng https:// (hoặc http://)")
        slack_url = os.getenv("SLACK_WEBHOOK_URL", "").strip() or None
        if slack_url and not slack_url.startswith(SLACK_WEBHOOK_PREFIX):
            raise ConfigError(f"SLACK_WEBHOOK_URL phải bắt đầu bằng {SLACK_WEBHOOK_PREFIX}")
        return cls(
            slack_webhook_url=slack_url,
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip() or None,
            reminder_catchup_minutes=_int_env("REMINDER_CATCHUP_MINUTES", 120),
            reminder_history_days=_int_env("REMINDER_HISTORY_DAYS", 30),
            jira_base_url=base_url,
            jira_pat=os.environ["JIRA_PAT"].strip(),
            max_rows=_int_env("MAX_ROWS", 5000),
            page_size=_int_env("PAGE_SIZE", 100),
            port=_int_env("PORT", 8000),
            ca_bundle=os.getenv("CA_BUNDLE", "").strip() or None,
        )


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} phải là số nguyên") from None
    if value <= 0:
        raise ConfigError(f"{name} phải lớn hơn 0")
    return value
