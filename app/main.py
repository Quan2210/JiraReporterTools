import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.cache import TTLCache
from app.config import Settings
from app.jira_client import JiraClient, JiraError
from app.jql import JqlError
from app.report_service import InvalidColumnError
from app.routers import export, meta, report

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def create_app(settings: Settings | None = None, client: JiraClient | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings or Settings.from_env()
        app.state.client = client or JiraClient(app.state.settings)
        app.state.cache = TTLCache()
        yield
        await app.state.client.aclose()

    app = FastAPI(title="Jira Report", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.exception_handler(JiraError)
    async def jira_error(_: Request, exc: JiraError):
        detail = f"{exc.message}: {exc.detail}" if exc.detail else exc.message
        return JSONResponse({"detail": detail}, status_code=exc.status_code)

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
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app()
