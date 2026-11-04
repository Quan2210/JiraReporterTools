import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.cache import TTLCache
from app.channels import ChannelError
from app.config import Settings
from app.jira_client import JiraClient, JiraError
from app.jql import JqlError
from app.reminder_scheduler import ReminderScheduler
from app.reminder_service import ReminderService
from app.reminder_store import ReminderStore
from app.report_service import InvalidColumnError
from app.routers import export, meta, reminders, report

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# httpx logs full request URLs at INFO; the Telegram token and Slack webhook live in those URLs.
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
DEFAULT_DB_PATH = ROOT / "data" / "reminders.db"
DEFAULT_ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})


def _host_only(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):                      # [::1]:8000
        return host.split("]")[0] + "]"
    return host.split(":")[0]


def create_app(
    settings: Settings | None = None,
    client: JiraClient | None = None,
    *,
    reminder_db_path: Path | str | None = None,
    scheduler: bool = False,
    allowed_hosts: frozenset[str] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings or Settings.from_env()
        app.state.client = client or JiraClient(app.state.settings)
        app.state.cache = TTLCache()
        store = ReminderStore(reminder_db_path or DEFAULT_DB_PATH)
        await asyncio.to_thread(store.init)
        # Separate from the Jira client on purpose: the Jira PAT must never be sent to Slack/Telegram.
        http = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0), verify=app.state.settings.ca_bundle or True)
        app.state.reminders = ReminderService(store, app.state.client, app.state.cache, app.state.settings, http)
        app.state.reminder_scheduler = ReminderScheduler(app.state.reminders)
        task = asyncio.create_task(app.state.reminder_scheduler.run_forever()) if scheduler else None
        yield
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await app.state.reminder_scheduler.stop()
        await http.aclose()
        await app.state.client.aclose()

    app = FastAPI(title="Jira Report", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def local_only_guard(request: Request, call_next):
        """/api/* is only for this app's own page on loopback: reject foreign Host (DNS rebinding) and foreign Origin."""
        if request.url.path.startswith("/api/"):
            hosts = allowed_hosts if allowed_hosts is not None else DEFAULT_ALLOWED_HOSTS
            host_header = request.headers.get("host", "")
            origin = request.headers.get("origin")
            if _host_only(host_header) not in hosts:
                return JSONResponse({"detail": "Host không được phép"}, status_code=403)
            if origin is not None and urlparse(origin).netloc.lower() != host_header.strip().lower():
                return JSONResponse({"detail": "Origin không được phép"}, status_code=403)
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            # The UI is ES modules that import each other: a stale cached module next to a new one breaks the page
            # ("does not provide an export named ..."). no-cache = always revalidate (ETag), still cheap.
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(JiraError)
    async def jira_error(_: Request, exc: JiraError):
        detail = f"{exc.message}: {exc.detail}" if exc.detail else exc.message
        return JSONResponse({"detail": detail}, status_code=exc.status_code)

    @app.exception_handler(ChannelError)
    async def channel_error(_: Request, exc: ChannelError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.exception_handler(JqlError)
    @app.exception_handler(InvalidColumnError)
    async def bad_input(_: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.get("/api/health")
    async def health(request: Request):
        me = await request.app.state.client.myself()
        return {
            "ok": True,
            "user": me.get("displayName") or me.get("name"),
            "jira_base_url": request.app.state.settings.jira_base_url,
            "max_rows": request.app.state.settings.max_rows,
        }

    app.include_router(meta.router)
    app.include_router(report.router)
    app.include_router(export.router)
    app.include_router(reminders.router)
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app(scheduler=True)
