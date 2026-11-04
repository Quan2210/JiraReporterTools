"""Background loop: every few seconds, find reminders whose newest slot is due and run them."""
import asyncio
import logging
from datetime import datetime, timedelta

from app.reminder_schedule import due_for, to_iso
from app.reminder_service import ReminderService

log = logging.getLogger("jira_report.reminders")

TICK_SECONDS = 30
MAX_CONCURRENT_RUNS = 3
PRUNE_EVERY = timedelta(hours=24)


class ReminderScheduler:
    def __init__(self, service: ReminderService, tick_seconds: float = TICK_SECONDS):
        self.service = service
        self.tick_seconds = tick_seconds
        self._sem = asyncio.Semaphore(MAX_CONCURRENT_RUNS)
        self._tasks: set[asyncio.Task] = set()
        self._last_prune: datetime | None = None

    async def _run_limited(self, reminder: dict, run_id: int) -> None:
        async with self._sem:
            await self.service.run(reminder, run_id)

    async def _maintenance(self, now: datetime) -> None:
        """Daily clean-up of old run history (also runs on the first tick after start)."""
        if self._last_prune is not None and now - self._last_prune < PRUNE_EVERY:
            return
        self._last_prune = now
        days = self.service.settings.reminder_history_days
        deleted = await asyncio.to_thread(self.service.store.prune_history, days, now)
        if deleted:
            log.info("reminder history: removed %d runs older than %d days", deleted, days)

    async def tick(self, now: datetime | None = None) -> list[asyncio.Task]:
        """Claim every due slot and start its run. Returns the started tasks (tests await them)."""
        now = now or datetime.now()
        await self._maintenance(now)
        catchup = timedelta(minutes=self.service.settings.reminder_catchup_minutes)
        store = self.service.store
        started: list[asyncio.Task] = []
        for reminder in await asyncio.to_thread(store.list_all):
            if not reminder["enabled"]:
                continue
            try:
                due = due_for(reminder, now, catchup)
            except ValueError:                      # corrupt schedule data: skip this reminder, keep the loop alive
                log.warning("reminder %s has an invalid schedule", reminder["id"])
                continue
            if due is None:
                continue
            action, slot = due
            slot_iso = to_iso(slot)
            once = reminder["schedule_kind"] == "once"
            if action == "missed":
                await asyncio.to_thread(store.record_missed, reminder["id"], slot_iso, once)
                continue
            run_id = await asyncio.to_thread(store.begin_scheduled_run, reminder["id"], slot_iso, once)
            if run_id is None:
                continue  # this slot is already claimed
            task = asyncio.create_task(self._run_limited(reminder, run_id))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
            started.append(task)
        return started

    async def run_forever(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("reminder tick failed: %s", type(exc).__name__)
            await asyncio.sleep(self.tick_seconds)

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
