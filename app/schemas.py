import re
from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, Field, model_validator

PROJECT_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,49}$")
FIELD_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,100}$")

MAX_JQL_LEN = 5000
MAX_VALUE_LEN = 255

Operator = Literal["in", "not_in", "eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty"]
MULTI_VALUE_OPS = {"in", "not_in"}
NO_VALUE_OPS = {"empty", "not_empty"}


MAX_DATE_OFFSET_DAYS = 3660          # keep equal to MAX_DATE_OFFSET_DAYS in static/js/lib/dates.js
DATE_FIELDS = ("created_from", "created_to", "updated_from", "updated_to")
DATE_TOKEN_RE = re.compile(r"^today(?:([+-])(\d{1,4}))?$")


def _today() -> date:
    return date.today()


def resolve_date_token(text: str, today: date | None = None) -> date:
    """"today", "today-7", "today+3" -> a real date (the machine's local date); ValueError on anything else."""
    match = DATE_TOKEN_RE.match(text.strip()) if isinstance(text, str) else None
    if not match:
        raise ValueError(f"Ngày động không hợp lệ: {text!r} (dùng today, today-N hoặc today+N)")
    offset = int(match.group(2) or 0)
    if offset > MAX_DATE_OFFSET_DAYS:
        raise ValueError(f"Ngày động tối đa {MAX_DATE_OFFSET_DAYS} ngày")
    base = today or _today()
    try:
        return base + timedelta(days=-offset if match.group(1) == "-" else offset)
    except OverflowError:
        raise ValueError("Ngày động nằm ngoài phạm vi") from None


class CustomFilter(BaseModel):
    """A filter on any searchable Jira field, chosen by field id (never by free-text clause name)."""

    field_id: str
    operator: Operator
    values: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def _check(self) -> "CustomFilter":
        if not FIELD_ID_RE.match(self.field_id):
            raise ValueError(f"Mã field không hợp lệ: {self.field_id!r}")
        if any(len(v) > MAX_VALUE_LEN for v in self.values):
            raise ValueError("Giá trị lọc quá dài")
        if self.operator in NO_VALUE_OPS:
            self.values = []
        elif self.operator in MULTI_VALUE_OPS:
            if not self.values:
                raise ValueError("Bộ lọc cần ít nhất một giá trị")
        elif len(self.values) != 1:
            raise ValueError("Toán tử này cần đúng một giá trị")
        return self


class ReportQuery(BaseModel):
    projects: list[str] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)
    sprints: list[int] = Field(default_factory=list)
    reporters: list[str] = Field(default_factory=list)
    reporter_groups: list[str] = Field(default_factory=list)
    assignees: list[str] = Field(default_factory=list)
    assignee_groups: list[str] = Field(default_factory=list)
    statuses: list[str] = Field(default_factory=list)
    issue_types: list[str] = Field(default_factory=list)
    created_from: date | None = None
    created_to: date | None = None
    updated_from: date | None = None
    updated_to: date | None = None
    custom_filters: list[CustomFilter] = Field(default_factory=list, max_length=20)
    # When set, JQL mode: used verbatim and every structured filter above is ignored.
    jql: str | None = None
    columns: list[str] = Field(min_length=1)
    max_rows: int | None = Field(default=None, gt=0)

    @model_validator(mode="before")
    @classmethod
    def _resolve_date_tokens(cls, data):
        """Dynamic dates ("today", "today-7") become real dates every time a query is built, i.e. per run."""
        if isinstance(data, dict):
            data = dict(data)
            for key in DATE_FIELDS:
                value = data.get(key)
                if isinstance(value, str) and value.strip().startswith("today"):
                    data[key] = resolve_date_token(value)
        return data

    @model_validator(mode="after")
    def _check(self) -> "ReportQuery":
        for key in self.projects:
            if not PROJECT_KEY_RE.match(key):
                raise ValueError(f"Project key không hợp lệ: {key!r}")
        for col in self.columns:
            if not FIELD_ID_RE.match(col):
                raise ValueError(f"Mã cột không hợp lệ: {col!r}")
        for lo, hi, name in (
            (self.created_from, self.created_to, "tạo"),
            (self.updated_from, self.updated_to, "cập nhật"),
        ):
            if lo and hi and lo > hi:
                raise ValueError(f"Ngày {name}: ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc")
        if self.jql is not None:
            self.jql = self.jql.strip()
            if not self.jql:
                self.jql = None
            elif len(self.jql) > MAX_JQL_LEN:
                raise ValueError("JQL quá dài")
            elif any(ord(ch) < 32 and ch not in "\t\r\n" for ch in self.jql):
                raise ValueError("JQL chứa ký tự điều khiển")
        return self


def query_for_storage(raw: dict) -> dict:
    """Validate a saved query and return only its valid keys. Dynamic dates keep their token (so each run
    resolves them again); everything else is the validated value. Unknown keys are dropped."""
    validated = ReportQuery.model_validate(raw)
    keys = {k for k in raw if k in ReportQuery.model_fields}
    out = validated.model_dump(mode="json", include=keys)
    for key in DATE_FIELDS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip().startswith("today"):
            out[key] = value.strip()
    return out
