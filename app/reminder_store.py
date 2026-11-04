"""SQLite storage for reminders and their run history (stdlib sqlite3, one short-lived connection per call)."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

from app.reminder_schedule import to_iso

MAX_RUNS_PER_REMINDER = 200
MAX_REMINDERS = 50

SCHEMA = """
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  query_json TEXT NOT NULL,
  template TEXT NOT NULL,
  channel TEXT NOT NULL,
  telegram_chat_id TEXT,
  days_json TEXT NOT NULL,
  time_hhmm TEXT NOT NULL,
  condition TEXT NOT NULL,
  max_lines INTEGER NOT NULL,
  active_since TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  schedule_kind TEXT NOT NULL DEFAULT 'weekly',
  run_at TEXT,
  title TEXT
);
CREATE TABLE IF NOT EXISTS reminder_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  row_count INTEGER,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_scheduled
  ON reminder_runs(reminder_id, scheduled_for) WHERE kind = 'scheduled';
"""

# Rows that history clean-up must never delete: the one-time reminder's own run (it makes the reminder "done").
_PROTECTED_RUN = (
    "(kind = 'scheduled' AND scheduled_for IN "     # IN, not "=": a weekly reminder has no such row (NULL would hide every row)
    "(SELECT run_at || ':00' FROM reminders WHERE reminders.id = reminder_runs.reminder_id AND schedule_kind = 'once'))"
)


def _now() -> str:
    return to_iso(datetime.now())


def _is_done(conn: sqlite3.Connection, row: sqlite3.Row) -> bool:
    if row["schedule_kind"] != "once" or row["enabled"] or not row["run_at"]:
        return False
    found = conn.execute(
        "SELECT 1 FROM reminder_runs WHERE reminder_id=? AND kind='scheduled' AND scheduled_for=?",
        (row["id"], f"{row['run_at']}:00")).fetchone()
    return found is not None


def _row_to_reminder(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    if row["enabled"]:
        state = "active"
    else:
        state = "done" if _is_done(conn, row) else "off"
    return {
        "id": row["id"],
        "name": row["name"],
        "enabled": bool(row["enabled"]),
        "state": state,
        "query": json.loads(row["query_json"]),
        "template": row["template"],
        "title": row["title"],
        "channel": row["channel"],
        "telegram_chat_id": row["telegram_chat_id"],
        "schedule_kind": row["schedule_kind"],
        "run_at": row["run_at"],
        "days": json.loads(row["days_json"]),
        "time": row["time_hhmm"],
        "condition": row["condition"],
        "max_lines": row["max_lines"],
        "active_since": row["active_since"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class ReminderLimitError(ValueError):
    pass


class ReminderStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.execute("PRAGMA journal_mode = WAL")
            c.executescript(SCHEMA)
            columns = {r["name"] for r in c.execute("PRAGMA table_info(reminders)")}
            if "schedule_kind" not in columns:       # database created before one-time reminders existed
                c.execute("ALTER TABLE reminders ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'weekly'")
            if "run_at" not in columns:
                c.execute("ALTER TABLE reminders ADD COLUMN run_at TEXT")
            if "title" not in columns:                 # message title template; NULL = the default title
                c.execute("ALTER TABLE reminders ADD COLUMN title TEXT")
            c.execute(
                "UPDATE reminder_runs SET status='failed', finished_at=?, error=? WHERE status='running'",
                (_now(), "Ứng dụng bị tắt giữa chừng"),
            )
            # A one-time reminder whose slot was already claimed must not stay "on" (e.g. app killed mid-run).
            c.execute(
                "UPDATE reminders SET enabled=0 WHERE schedule_kind='once' AND enabled=1 AND EXISTS ("
                " SELECT 1 FROM reminder_runs r WHERE r.reminder_id = reminders.id AND r.kind='scheduled'"
                " AND r.scheduled_for = reminders.run_at || ':00')")

    # ---- reminders ----

    def list_all(self) -> list[dict]:
        with self._conn() as c:
            out = [_row_to_reminder(c, r) for r in c.execute("SELECT * FROM reminders ORDER BY id").fetchall()]
            for item in out:
                last = c.execute(
                    "SELECT kind, status, started_at, row_count, error FROM reminder_runs "
                    "WHERE reminder_id=? ORDER BY id DESC LIMIT 1", (item["id"],)).fetchone()
                item["last_run"] = dict(last) if last else None
            return out

    def get(self, reminder_id: int) -> dict | None:
        with self._conn() as c:
            row = c.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
            return _row_to_reminder(c, row) if row else None

    def create(self, data: dict) -> int:
        now = _now()
        with self._conn() as c:
            if c.execute("SELECT COUNT(*) FROM reminders").fetchone()[0] >= MAX_REMINDERS:
                raise ReminderLimitError(f"Tối đa {MAX_REMINDERS} nhắc nhở")
            cur = c.execute(
                "INSERT INTO reminders(name, enabled, query_json, template, channel, telegram_chat_id, days_json,"
                " time_hhmm, condition, max_lines, active_since, created_at, updated_at, schedule_kind, run_at, title)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (data["name"], int(data["enabled"]), json.dumps(data["query"]), data["template"], data["channel"],
                 data["telegram_chat_id"], json.dumps(data["days"]), data["time"], data["condition"],
                 data["max_lines"], now, now, now, data.get("schedule_kind", "weekly"), data.get("run_at"), data.get("title")))
            return cur.lastrowid

    def update(self, reminder_id: int, data: dict) -> bool:
        """`active_since` restarts when the schedule changes or the reminder goes from off to on,
        so editing never fires an old slot immediately."""
        now = _now()
        kind = data.get("schedule_kind", "weekly")
        run_at = data.get("run_at")
        with self._conn() as c:
            row = c.execute("SELECT * FROM reminders WHERE id=?", (reminder_id,)).fetchone()
            if row is None:
                return False
            old = _row_to_reminder(c, row)
            restart = (
                kind != old["schedule_kind"] or run_at != old["run_at"]
                or data["days"] != old["days"] or data["time"] != old["time"]
                or (data["enabled"] and not old["enabled"])
            )
            c.execute(
                "UPDATE reminders SET name=?, enabled=?, query_json=?, template=?, channel=?, telegram_chat_id=?,"
                " days_json=?, time_hhmm=?, condition=?, max_lines=?, active_since=?, updated_at=?,"
                " schedule_kind=?, run_at=?, title=? WHERE id=?",
                (data["name"], int(data["enabled"]), json.dumps(data["query"]), data["template"], data["channel"],
                 data["telegram_chat_id"], json.dumps(data["days"]), data["time"], data["condition"],
                 data["max_lines"], now if restart else old["active_since"], now, kind, run_at, data.get("title"), reminder_id))
            return True

    def delete(self, reminder_id: int) -> bool:
        with self._conn() as c:
            return c.execute("DELETE FROM reminders WHERE id=?", (reminder_id,)).rowcount > 0

    # ---- runs ----

    def begin_scheduled_run(self, reminder_id: int, slot_iso: str, disable_once: bool = False) -> int | None:
        """Claim a slot. None if it was already claimed (running, sent, missed...) -> never send twice.
        For a one-time reminder the claim and "turn the reminder off" happen in ONE transaction, so a crash
        can never leave it enabled but unable to run."""
        try:
            with self._conn() as c:
                cur = c.execute(
                    "INSERT INTO reminder_runs(reminder_id, kind, scheduled_for, started_at, status)"
                    " VALUES (?, 'scheduled', ?, ?, 'running')", (reminder_id, slot_iso, _now()))
                if disable_once:
                    c.execute("UPDATE reminders SET enabled=0 WHERE id=?", (reminder_id,))
                return cur.lastrowid
        except sqlite3.IntegrityError:
            return None

    def begin_manual_run(self, reminder_id: int) -> int:
        now = datetime.now()
        with self._conn() as c:
            cur = c.execute(
                "INSERT INTO reminder_runs(reminder_id, kind, scheduled_for, started_at, status)"
                " VALUES (?, 'manual', ?, ?, 'running')",
                (reminder_id, now.strftime("%Y-%m-%dT%H:%M:%S.%f"), to_iso(now)))
            return cur.lastrowid

    def record_missed(self, reminder_id: int, slot_iso: str, disable_once: bool = False) -> bool:
        try:
            with self._conn() as c:
                c.execute(
                    "INSERT INTO reminder_runs(reminder_id, kind, scheduled_for, started_at, finished_at, status, error)"
                    " VALUES (?, 'scheduled', ?, ?, ?, 'missed', ?)",
                    (reminder_id, slot_iso, _now(), _now(), "Ứng dụng không chạy đúng giờ hẹn"))
                if disable_once:
                    c.execute("UPDATE reminders SET enabled=0 WHERE id=?", (reminder_id,))
                return True
        except sqlite3.IntegrityError:
            return False

    def finish_run(self, run_id: int, status: str, row_count: int | None = None, error: str | None = None) -> None:
        with self._conn() as c:
            c.execute("UPDATE reminder_runs SET status=?, finished_at=?, row_count=?, error=? WHERE id=?",
                      (status, _now(), row_count, error, run_id))
            rid = c.execute("SELECT reminder_id FROM reminder_runs WHERE id=?", (run_id,)).fetchone()
            if rid:
                c.execute(
                    "DELETE FROM reminder_runs WHERE reminder_id=? AND NOT " + _PROTECTED_RUN + " AND id NOT IN "
                    "(SELECT id FROM reminder_runs WHERE reminder_id=? ORDER BY id DESC LIMIT ?)",
                    (rid[0], rid[0], MAX_RUNS_PER_REMINDER))

    def prune_history(self, days: int, now: datetime | None = None) -> int:
        """Delete run history older than `days`. Keeps running rows, the newest run of every reminder (so the
        list never shows "never ran" for a reminder that did) and a one-time reminder's own run."""
        cutoff = to_iso((now or datetime.now()) - timedelta(days=days))
        with self._conn() as c:
            return c.execute(
                "DELETE FROM reminder_runs WHERE started_at < ? AND status != 'running' AND NOT " + _PROTECTED_RUN +
                " AND id NOT IN (SELECT MAX(id) FROM reminder_runs GROUP BY reminder_id)", (cutoff,)).rowcount

    def list_runs(self, reminder_id: int, limit: int = 50) -> list[dict]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT id, kind, scheduled_for, started_at, finished_at, status, row_count, error "
                "FROM reminder_runs WHERE reminder_id=? ORDER BY id DESC LIMIT ?", (reminder_id, limit)).fetchall()
            return [dict(r) for r in rows]
