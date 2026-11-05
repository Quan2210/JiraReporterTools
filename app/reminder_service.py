"""Runs one reminder: query Jira -> apply the rules -> render the message -> send it -> record the outcome."""
import asyncio
import hashlib
import logging
from dataclasses import dataclass

import httpx

from app.cache import TTLCache
from app.channels import ChannelError, send_slack, send_telegram
from app.config import Settings
from app.jira_client import JiraClient, JiraError
from app.message import BUILTIN_VARIABLES, placeholders, render_line, render_title
from app.note_rules import Entry, arrange, evaluate
from app.reminder_store import ReminderStore
from app.report_service import get_field_meta, run_query
from app.schemas import ReportQuery

log = logging.getLogger("jira_report.reminders")

RUN_TIMEOUT_SECONDS = 120
RETRY_DELAY_SECONDS = 30
MAX_EXTRA_COLUMNS = 30
# Rows always carry summary/status/url; the query only needs these base columns.
REMINDER_COLUMNS = ["issuekey", "summary", "status"]

SKIP_REASONS = {
    "skipped_empty": "Không có issue nào",
    "skipped_condition": "Chưa đủ điều kiện gửi",
    "skipped_unchanged": "Danh sách không đổi so với lần gửi trước",
}


@dataclass
class Prepared:
    """A query result after the note/hide rules: what the message will contain."""
    entries: list[Entry]
    sections: list
    hidden: int
    count: int            # issues that would be listed (rows beyond the row limit count as visible)
    matched: int          # issues a note rule applied to
    signature: str        # identifies the list (key + status), for "only when the list changed"


def prepare(reminder: dict, result: dict) -> Prepared:
    entries, hidden = evaluate(result["rows"], reminder.get("note_rules") or [], reminder.get("default_note"),
                               lambda text, row: render_line(text, row))
    beyond = max(0, result["total"] - len(result["rows"])) if result.get("truncated") else 0
    sections = arrange(entries, reminder.get("group_by"), reminder.get("group_order") or "name",
                       reminder.get("sort_by"), reminder.get("sort_dir") or "asc")
    keys = sorted(f"{e.row.get('key')}|{e.row.get('status')}" for e in entries)
    return Prepared(
        entries=entries, sections=sections, hidden=hidden, count=len(entries) + beyond,
        matched=sum(1 for e in entries if e.matched), signature=hashlib.sha256("\n".join(keys).encode()).hexdigest(),
    )


def fields_used(reminder: dict) -> list[str]:
    """Jira fields the message needs beyond the base columns: template / note variables, rule fields, group, sort."""
    names = placeholders(reminder.get("template"))
    for rule in reminder.get("note_rules") or []:
        names.append(rule.get("field", ""))
        names += placeholders(rule.get("text"))
    names += placeholders(reminder.get("default_note"))
    names += [reminder.get("group_by") or "", reminder.get("sort_by") or ""]
    return [n for n in dict.fromkeys(names) if n and n not in BUILTIN_VARIABLES and n not in REMINDER_COLUMNS]


def build_text(reminder: dict, prepared: Prepared) -> str:
    lines = [render_title(reminder.get("title"), reminder["name"], prepared.count)]
    budget = reminder["max_lines"]
    shown = 0
    for name, items in prepared.sections:
        if budget <= 0:
            break
        take = items[:budget]
        if name is not None:
            lines.append(f"▸ {name or '(trống)'} ({len(items)})")
        lines += [render_line(reminder["template"], e.row, e.note) for e in take]
        budget -= len(take)
        shown += len(take)
    if prepared.count > shown:
        lines.append(f"… và {prepared.count - shown} issue nữa")
    return "\n".join(lines)


def skip_status(reminder: dict, prepared: Prepared, check_changed: bool = True) -> str | None:
    """Why a (non-forced) run should not send, or None."""
    condition = reminder.get("condition") or "always"
    if condition == "only_if_results" and prepared.count == 0:
        return "skipped_empty"
    if condition == "min_count" and prepared.count < (reminder.get("min_count") or 1):
        return "skipped_condition"
    if condition == "if_rule" and prepared.matched == 0:
        return "skipped_condition"
    if condition == "if_changed" and check_changed and prepared.signature == reminder.get("last_signature"):
        return "skipped_unchanged"
    return None


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

    async def _columns(self, template: str, extra=()) -> list[str]:
        """The base columns plus every known Jira field the message mentions ({assignee}, rule fields, group...)."""
        wanted = [n for n in dict.fromkeys([*placeholders(template), *extra])
                  if n and n not in BUILTIN_VARIABLES and n not in REMINDER_COLUMNS]
        if not wanted:
            return REMINDER_COLUMNS
        known = await get_field_meta(self.client, self.cache)
        return REMINDER_COLUMNS + [n for n in wanted if n in known][:MAX_EXTRA_COLUMNS]

    async def _query(self, query: dict, template: str = "", extra=()) -> dict:
        data = {**query, "columns": await self._columns(template, extra)}
        return await run_query(ReportQuery(**data), self.client, self.cache, self.settings)

    async def _fetch(self, reminder: dict) -> dict:
        return await self._query(reminder["query"], reminder["template"], fields_used(reminder))

    def build_text(self, reminder: dict, result: dict) -> str:
        return build_text(reminder, prepare(reminder, result))

    async def preview(self, data: dict) -> dict:
        """What the message would look like (and whether it would be sent) for the form's current values."""
        reminder = {**data, "id": 0}
        result = await self._fetch(reminder)
        prepared = prepare(reminder, result)
        skip = skip_status(reminder, prepared, check_changed=False)
        return {
            "text": build_text(reminder, prepared), "row_count": len(prepared.entries), "total": result["total"],
            "jql": result["jql"], "hidden": prepared.hidden, "matched": prepared.matched,
            "decision": {"send": skip is None, "reason": SKIP_REASONS.get(skip) if skip else None},
        }

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
        if reminder.get("custom_message") and reminder.get("schedule_kind") == "once":
            # A hand-edited one-time message is sent exactly as written: no query, no rules, no conditions.
            await self._deliver_with_retry(reminder, reminder["custom_message"])
            return "sent", 0
        result = await self._fetch(reminder)
        prepared = prepare(reminder, result)
        if not force_send:
            skipped = skip_status(reminder, prepared)
            if skipped:
                return skipped, prepared.count
        await self._deliver_with_retry(reminder, build_text(reminder, prepared))
        if not force_send and reminder.get("id"):
            self.store.set_signature(reminder["id"], prepared.signature)
        return "sent", prepared.count

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
            self.store.finish_run(run_id, status, count, SKIP_REASONS.get(status))
            return status
        except Exception as exc:  # noqa: BLE001
            error = self._error_text(exc)
            if not isinstance(exc, (asyncio.TimeoutError, JiraError, ChannelError, ValueError)):
                log.warning("reminder %s failed: %s", reminder["id"], type(exc).__name__)
        log.info("reminder %s run %s failed: %s", reminder["id"], run_id, error)
        self.store.finish_run(run_id, "failed", None, error)
        return "failed"

    async def send_adhoc(self, data: dict) -> dict:
        """Send once with unsaved settings ("Gửi thử ngay"): same timeout, no retry, no history, no conditions."""
        reminder = {**data, "id": 0}

        async def go() -> int:
            if reminder.get("custom_message"):
                await self.deliver(reminder, f"[Gửi thử] {reminder['custom_message']}")
                return 0
            result = await self._fetch(reminder)
            prepared = prepare(reminder, result)
            # the marker goes in front of whatever the title is, even a custom one without {name}
            await self.deliver(reminder, f"[Gửi thử] {build_text(reminder, prepared)}")
            return len(prepared.entries)

        try:
            count = await asyncio.wait_for(go(), self.run_timeout)
        except Exception as exc:  # noqa: BLE001
            return {"status": "failed", "row_count": None, "error": self._error_text(exc)}
        return {"status": "sent", "row_count": count, "error": None}
