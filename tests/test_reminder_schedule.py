from datetime import datetime, timedelta

from app.reminder_schedule import due_slot, latest_slot

CATCHUP = timedelta(minutes=120)
MON_FRI = [0, 1, 2, 3, 4]


def dt(*a):
    return datetime(*a)


def test_latest_slot_today_after_time():
    assert latest_slot(MON_FRI, "09:00", dt(2026, 11, 4, 10, 0)) == dt(2026, 11, 4, 9, 0)   # Wednesday


def test_latest_slot_before_time_goes_back_to_previous_day():
    assert latest_slot(MON_FRI, "09:00", dt(2026, 11, 4, 8, 0)) == dt(2026, 11, 3, 9, 0)


def test_latest_slot_skips_weekend():
    assert latest_slot(MON_FRI, "09:00", dt(2026, 11, 8, 12, 0)) == dt(2026, 11, 6, 9, 0)   # Sunday -> Friday


def test_latest_slot_no_days():
    assert latest_slot([], "09:00", dt(2026, 11, 4)) is None


def test_due_inside_catchup_window_runs():
    r = due_slot(MON_FRI, "09:00", dt(2026, 11, 1), dt(2026, 11, 4, 10, 30), CATCHUP)
    assert r == ("run", dt(2026, 11, 4, 9, 0))


def test_due_outside_catchup_window_is_missed():
    r = due_slot(MON_FRI, "09:00", dt(2026, 11, 1), dt(2026, 11, 4, 11, 30), CATCHUP)
    assert r == ("missed", dt(2026, 11, 4, 9, 0))


def test_slot_before_active_since_is_ignored():
    # created / rescheduled / re-enabled at 10:00: the 09:30 slot of today must not fire
    assert due_slot(MON_FRI, "09:30", dt(2026, 11, 4, 10, 0), dt(2026, 11, 4, 10, 5), CATCHUP) is None


def test_only_the_newest_slot_is_considered():
    r = due_slot(MON_FRI, "09:00", dt(2026, 10, 1), dt(2026, 11, 4, 9, 1), CATCHUP)
    assert r == ("run", dt(2026, 11, 4, 9, 0))
