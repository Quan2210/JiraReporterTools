"""Pure schedule maths. All datetimes are naive local time of this machine (Vietnam has no DST)."""
from datetime import datetime, timedelta

TIME_FMT = "%H:%M"
ISO_FMT = "%Y-%m-%dT%H:%M:%S"
RUN_AT_FMT = "%Y-%m-%dT%H:%M"


def latest_slot(days: list[int], hhmm: str, now: datetime) -> datetime | None:
    """Most recent scheduled moment <= now. `days` are weekdays, Monday=0 ... Sunday=6."""
    if not days:
        return None
    hour, minute = (int(p) for p in hhmm.split(":"))
    for back in range(8):
        day = now.date() - timedelta(days=back)
        if day.weekday() not in days:
            continue
        slot = datetime(day.year, day.month, day.day, hour, minute)
        if slot <= now:
            return slot
    return None


def next_slot(days: list[int], hhmm: str, now: datetime) -> datetime | None:
    """First scheduled moment strictly after `now`."""
    if not days:
        return None
    hour, minute = (int(p) for p in hhmm.split(":"))
    for ahead in range(8):
        day = now.date() + timedelta(days=ahead)
        if day.weekday() not in days:
            continue
        slot = datetime(day.year, day.month, day.day, hour, minute)
        if slot > now:
            return slot
    return None


def due_slot(
    days: list[int], hhmm: str, active_since: datetime, now: datetime, catchup: timedelta
) -> tuple[str, datetime] | None:
    """What the scheduler should do for the newest slot.

    ("run", slot): inside the catch-up window. ("missed", slot): too late to send.
    None: no slot, or the slot is not after `active_since` (created / rescheduled / re-enabled later).
    """
    slot = latest_slot(days, hhmm, now)
    if slot is None or slot <= active_since:
        return None
    return ("run", slot) if now - slot <= catchup else ("missed", slot)


def parse_run_at(text: str) -> datetime:
    return datetime.strptime(text, RUN_AT_FMT)


def due_for(reminder: dict, now: datetime, catchup: timedelta) -> tuple[str, datetime] | None:
    """`due_slot` for weekly reminders; for a one-time reminder the only slot is `run_at`."""
    active_since = from_iso(reminder["active_since"])
    if reminder.get("schedule_kind") == "once":
        slot = parse_run_at(reminder["run_at"])
        if slot <= active_since or now < slot:
            return None
        return ("run", slot) if now - slot <= catchup else ("missed", slot)
    return due_slot(reminder["days"], reminder["time"], active_since, now, catchup)


def next_run(reminder: dict, now: datetime) -> datetime | None:
    """When an enabled reminder fires next (a pending one-time reminder: its run_at)."""
    if not reminder["enabled"]:
        return None
    if reminder.get("schedule_kind") == "once":
        return parse_run_at(reminder["run_at"])
    return next_slot(reminder["days"], reminder["time"], now)


def to_iso(value: datetime) -> str:
    return value.strftime(ISO_FMT)


def from_iso(text: str) -> datetime:
    return datetime.strptime(text, ISO_FMT)
