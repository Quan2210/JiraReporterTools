import asyncio
import json
import re
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import AfterValidator, BaseModel, Field, ValidationError, field_validator, model_validator

from app.channels import telegram_chats
from app.reminder_schedule import next_run, parse_run_at, to_iso
from app.reminder_store import ReminderLimitError
from app.schemas import query_for_storage

router = APIRouter(prefix="/api")

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
RUN_AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$")
CHAT_ID_RE = re.compile(r"^-?\d{1,20}$")
DEFAULT_TEMPLATE = "{key}: {summary} [{status}] {url}"
MAX_QUERY_JSON_BYTES = 32 * 1024


def _check_query(value: dict[str, Any]) -> dict[str, Any]:
    """Validate with ReportQuery but keep dynamic-date tokens; drop unknown keys; cap the size."""
    try:
        stored = query_for_storage(value)
    except ValidationError as exc:
        first = exc.errors()[0]
        raise ValueError(f"Bộ lọc không hợp lệ: {first.get('msg', 'sai định dạng')}") from None
    if len(json.dumps(stored).encode("utf-8")) > MAX_QUERY_JSON_BYTES:
        raise ValueError("Bộ lọc quá lớn")
    return stored


QueryDict = Annotated[dict[str, Any], AfterValidator(_check_query)]


class ReminderCore(BaseModel):
    """Everything about a reminder except its schedule; also the body of "send a test now"."""

    name: str = Field(min_length=1, max_length=100)
    query: QueryDict
    template: str = Field(default=DEFAULT_TEMPLATE, min_length=1, max_length=1000)
    title: str | None = Field(default=None, max_length=200)      # message title template; empty = default
    channel: Literal["slack", "telegram"]
    telegram_chat_id: str | None = None
    condition: Literal["always", "only_if_results"] = "always"
    max_lines: int = Field(default=30, ge=1, le=100)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Tên nhắc nhở không được để trống")
        return value

    @field_validator("title")
    @classmethod
    def _title(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        return value or None

    @model_validator(mode="after")
    def _channel(self):
        if self.channel == "telegram":
            if not self.telegram_chat_id or not CHAT_ID_RE.match(self.telegram_chat_id):
                raise ValueError("Kênh Telegram cần chat_id (số)")
        else:
            self.telegram_chat_id = None
        return self


class ReminderIn(ReminderCore):
    enabled: bool = True
    schedule_kind: Literal["weekly", "once"] = "weekly"
    days: list[int] = Field(default_factory=list, max_length=7)
    time: str | None = None
    run_at: str | None = None           # one-time reminders: "YYYY-MM-DDTHH:MM", local time

    @field_validator("days")
    @classmethod
    def _days(cls, value: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in value):
            raise ValueError("Ngày trong tuần phải từ 0 (thứ 2) đến 6 (chủ nhật)")
        return sorted(set(value))

    @model_validator(mode="after")
    def _schedule(self):
        if self.schedule_kind == "once":
            if not self.run_at or not RUN_AT_RE.match(self.run_at):
                raise ValueError("Nhắc nhở một lần cần ngày giờ gửi (YYYY-MM-DDTHH:MM)")
            try:
                parse_run_at(self.run_at)
            except ValueError:
                raise ValueError("Ngày giờ gửi không hợp lệ") from None
            self.days = []
            self.time = self.run_at[11:]
        else:
            if not self.days:
                raise ValueError("Hãy chọn ít nhất một ngày trong tuần")
            if not self.time or not TIME_RE.match(self.time):
                raise ValueError("Giờ phải có dạng HH:MM")
            self.run_at = None
        return self


class PreviewIn(BaseModel):
    query: QueryDict
    template: str = Field(default=DEFAULT_TEMPLATE, min_length=1, max_length=1000)
    title: str | None = Field(default=None, max_length=200)
    name: str = Field(default="Xem trước", min_length=1, max_length=100)
    max_lines: int = Field(default=30, ge=1, le=100)


def _service(request: Request):
    return request.app.state.reminders


def _decorate(reminder: dict | None) -> dict | None:
    if reminder is not None:
        upcoming = next_run(reminder, datetime.now())
        reminder["next_run"] = to_iso(upcoming) if upcoming else None
    return reminder


def _check_channel(service, body: ReminderCore, enabled: bool = True) -> None:
    if enabled and not service.is_configured(body.channel):
        raise HTTPException(422, f"Kênh {body.channel} chưa được cấu hình trong .env")


def _check_once_in_future(body: ReminderIn, old: dict | None) -> None:
    """A one-time reminder can't be created in the past, nor moved or re-enabled into it. One that is already
    enabled and whose time has just arrived (waiting for the next tick) is left alone."""
    if body.schedule_kind != "once" or parse_run_at(body.run_at) > datetime.now():
        return
    if old is not None:
        changed = old["schedule_kind"] != "once" or old["run_at"] != body.run_at
        turning_on = body.enabled and not old["enabled"]
        if not (changed or turning_on):
            return
    raise HTTPException(422, "Thời điểm gửi đã qua. Hãy đặt ngày giờ ở tương lai.")


@router.get("/channels")
async def channels(request: Request):
    return _service(request).channel_status()


@router.post("/channels/telegram/chats")
async def discover_chats(request: Request):
    service = _service(request)
    if not service.settings.telegram_bot_token:
        raise HTTPException(422, "TELEGRAM_BOT_TOKEN chưa được cấu hình trong .env")
    return {"chats": await telegram_chats(service.http, service.settings.telegram_bot_token)}


@router.get("/reminders")
async def list_reminders(request: Request):
    reminders = await asyncio.to_thread(_service(request).store.list_all)
    return {"reminders": [_decorate(r) for r in reminders]}


@router.post("/reminders", status_code=201)
async def create_reminder(body: ReminderIn, request: Request):
    service = _service(request)
    _check_channel(service, body, body.enabled)
    _check_once_in_future(body, None)
    try:
        new_id = await asyncio.to_thread(service.store.create, body.model_dump(mode="json"))
    except ReminderLimitError as exc:
        raise HTTPException(422, str(exc)) from None
    return _decorate(await asyncio.to_thread(service.store.get, new_id))


@router.post("/reminders/preview")
async def preview(body: PreviewIn, request: Request):
    return await _service(request).preview(body.query, body.template, body.max_lines, body.name.strip() or "Xem trước", (body.title or "").strip() or None)


@router.post("/reminders/send-test")
async def send_test_now(body: ReminderCore, request: Request):
    """Send right now with the (possibly unsaved) form values. Not recorded in any history."""
    service = _service(request)
    _check_channel(service, body)
    return await service.send_adhoc(body.model_dump(mode="json"))


@router.put("/reminders/{reminder_id}")
async def update_reminder(reminder_id: int, body: ReminderIn, request: Request):
    service = _service(request)
    old = await asyncio.to_thread(service.store.get, reminder_id)
    if old is None:
        raise HTTPException(404, "Không tìm thấy nhắc nhở")
    _check_channel(service, body, body.enabled)
    _check_once_in_future(body, old)
    if not await asyncio.to_thread(service.store.update, reminder_id, body.model_dump(mode="json")):
        raise HTTPException(404, "Không tìm thấy nhắc nhở")
    return _decorate(await asyncio.to_thread(service.store.get, reminder_id))


@router.delete("/reminders/{reminder_id}", status_code=204)
async def delete_reminder(reminder_id: int, request: Request):
    if not await asyncio.to_thread(_service(request).store.delete, reminder_id):
        raise HTTPException(404, "Không tìm thấy nhắc nhở")


@router.post("/reminders/{reminder_id}/test")
async def send_test(reminder_id: int, request: Request):
    """Send now (ignores the schedule and the only-if-results condition)."""
    service = _service(request)
    reminder = await asyncio.to_thread(service.store.get, reminder_id)
    if reminder is None:
        raise HTTPException(404, "Không tìm thấy nhắc nhở")
    run_id = await asyncio.to_thread(service.store.begin_manual_run, reminder_id)
    status = await service.run(reminder, run_id, force_send=True)
    runs = await asyncio.to_thread(service.store.list_runs, reminder_id, 1)
    return {"status": status, "error": runs[0]["error"] if runs else None}


@router.get("/reminders/{reminder_id}/runs")
async def runs(reminder_id: int, request: Request):
    service = _service(request)
    if await asyncio.to_thread(service.store.get, reminder_id) is None:
        raise HTTPException(404, "Không tìm thấy nhắc nhở")
    return {"runs": await asyncio.to_thread(service.store.list_runs, reminder_id)}
