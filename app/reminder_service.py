"""Runs one reminder: query Jira -> render the message -> send it -> record the outcome."""
import asyncio
import logging

import httpx

from app.cache import TTLCache
from app.channels import ChannelError, send_slack, send_telegram
from app.config import Settings
from app.jira_client import JiraClient, JiraError
from app.message import BUILTIN_VARIABLES, placeholders, render_line, render_title
from app.reminder_store import ReminderStore
from app.report_service import get_field_meta, run_query
from app.schemas import ReportQuery

log = logging.getLogger("jira_report.reminders")

RUN_TIMEOUT_SECONDS = 120
RETRY_DELAY_SECONDS = 30
# Rows always carry summary/status/url; the query only needs the key column.
MAX_EXTRA_COLUMNS = 30
REMINDER_COLUMNS = ["issuekey", "summary", "status"]


class ReminderService:
    def __init__(
        self, store: ReminderStore, client: JiraClient, cache: TTLCache, settings: Settings, http: httpx.AsyncClient,
        retry_delay: float | None = None, run_timeout: float | None = None,
    ):
        self.store = store
        self.client = client
        self.cache = cache
        self.settings = settings
        self.http = http
        # module constants are read at call time so tests can shrink them
        self.retry_delay = RETRY_DELAY_SECONDS if retry_delay is None else retry_delay
        self.run_timeout = RUN_TIMEOUT_SECONDS if run_timeout is None else run_timeout

    def channel_status(self) -> dict:
        return {
            "slack": {"configured": bool(self.settings.slack_webhook_url)},
            "telegram": {"configured": bool(self.settings.telegram_bot_token)},
        }

    def is_configured(self, channel: str) -> bool:
        return self.channel_status().get(channel, {}).get("configured", False)

    async def _columns(self, template: str, title: str = "") -> list[str]:
        """The base columns plus every Jira field the template / title mentions ({assignee}, {created}, ...)."""
        extra = [n for n in placeholders(template) if n not in BUILTIN_VARIABLES]
        if not extra:
            return REMINDER_COLUMNS
        known = await get_field_meta(self.client, self.cache)
        return REMINDER_COLUMNS + [n for n in extra if n in known and n not in REMINDER_COLUMNS][:MAX_EXTRA_COLUMNS]

    async def _query(self, query: dict, template: str = "") -> dict:
        data = {**query, "columns": await self._columns(template)}
        return await run_query(ReportQuery(**data), self.client, self.cache, self.settings)

    @staticmethod
    def build_text(reminder: dict, result: dict) -> str:
        rows = result["rows"]
        shown = rows[: reminder["max_lines"]]
        total = result["total"] if result.get("truncated") else len(rows)
        lines = [render_title(reminder.get("title"), reminder["name"], total)]
        lines += [render_line(reminder["template"], row) for row in shown]
        if total > len(shown):
            lines.append(f"… và {total - len(shown)} issue nữa")
        return "\n".join(lines)

    async def preview(self, query: dict, template: str, max_lines: int, name: str = "Xem trước", title: str | None = None) -> dict:
        result = await self._query(query, template)
        text = self.build_text({"name": name, "template": template, "max_lines": max_lines, "title": title}, result)
        return {"text": text, "row_count": len(result["rows"]), "total": result["total"], "jql": result["jql"]}

    async def deliver(self, reminder: dict, text: str) -> None:
        if reminder["channel"] == "slack":
            if not self.settings.slack_webhook_url:
                raise ChannelError("Slack chưa được cấu hình trong .env")
            await send_slack(self.http, self.settings.slack_webhook_url, text)
        elif reminder["channel"] == "telegram":
            if not self.settings.telegram_bot_token:
                raise ChannelError("Telegram chưa được cấu hình trong .env")
            if not reminder.get("telegram_chat_id"):
                raise ChannelError("Nhắc nhở Telegram chưa có chat_id")
            await send_telegram(self.http, self.settings.telegram_bot_token, reminder["telegram_chat_id"], text)
        else:
            raise ChannelError("Kênh không hợp lệ")

    async def _deliver_with_retry(self, reminder: dict, text: str) -> None:
        try:
            await self.deliver(reminder, text)
        except ChannelError as exc:
            if not exc.retryable:
                raise
            await asyncio.sleep(self.retry_delay)
            await self.deliver(reminder, text)

    async def _execute(self, reminder: dict, force_send: bool) -> tuple[str, int]:
        result = await self._query(reminder["query"], reminder["template"])
        count = len(result["rows"])
        if count == 0 and reminder["condition"] == "only_if_results" and not force_send:
            return "skipped_empty", 0
        await self._deliver_with_retry(reminder, self.build_text(reminder, result))
        return "sent", count

    @staticmethod
    def _error_text(exc: BaseException) -> str:
        """Safe text only: never str(exc) of an unknown error (it may hold a secret URL)."""
        if isinstance(exc, asyncio.TimeoutError):
            return "Quá thời gian chờ"
        if isinstance(exc, JiraError):
            return exc.message
        if isinstance(exc, ChannelError):
            return str(exc)
        if isinstance(exc, ValueError):          # our own validation / JQL errors: no secrets in them
            return f"Bộ lọc không hợp lệ: {str(exc)[:200]}"
        return f"Lỗi không xác định ({type(exc).__name__})"

    async def run(self, reminder: dict, run_id: int, force_send: bool = False) -> str:
        """Always finishes the run row; never raises (one bad reminder must not stop the others)."""
        try:
            status, count = await asyncio.wait_for(self._execute(reminder, force_send), self.run_timeout)
            self.store.finish_run(run_id, status, count, None)
            return status
        except Exception as exc:  # noqa: BLE001
            error = self._error_text(exc)
            if not isinstance(exc, (asyncio.TimeoutError, JiraError, ChannelError, ValueError)):
                log.warning("reminder %s failed: %s", reminder["id"], type(exc).__name__)
        log.info("reminder %s run %s failed: %s", reminder["id"], run_id, error)
        self.store.finish_run(run_id, "failed", None, error)
        return "failed"

    async def send_adhoc(self, data: dict) -> dict:
        """Send once with unsaved settings ("Gửi thử ngay"): same timeout, no retry, no history."""
        reminder = {**data, "id": 0}

        async def go() -> int:
            result = await self._query(reminder["query"], reminder["template"])
            # the marker goes in front of whatever the title is, even a custom one without {name}
            await self.deliver(reminder, f"[Gửi thử] {self.build_text(reminder, result)}")
            return len(result["rows"])

        try:
            count = await asyncio.wait_for(go(), self.run_timeout)
        except Exception as exc:  # noqa: BLE001
            return {"status": "failed", "row_count": None, "error": self._error_text(exc)}
        return {"status": "sent", "row_count": count, "error": None}
