import os
import sys
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent


def _ensure_stdio() -> None:
    """pythonw.exe (background run) has no console: sys.stdout/stderr are None and uvicorn's logging crashes."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_dir = ROOT / "logs"
    log_dir.mkdir(exist_ok=True)
    stream = open(log_dir / "app.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or stream
    sys.stderr = sys.stderr or stream


if __name__ == "__main__":
    _ensure_stdio()
    load_dotenv(ROOT / ".env")
    # Bound to loopback only: the app holds the Jira PAT and has no login of its own.
    uvicorn.run("app.main:app", host="127.0.0.1", port=int(os.getenv("PORT", "8000")), log_config=None)
