from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, model_validator

from app.exporter import HEX_COLOR_RE, to_csv, to_xlsx

router = APIRouter(prefix="/api")

MAX_COLUMNS = 100
MAX_CELL_CHARS = 32000  # Excel's per-cell limit
_XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class ExportRequest(BaseModel):
    """A table already assembled by the browser (selected rows, order, notes, colours)."""

    headers: list[str] = Field(min_length=1, max_length=MAX_COLUMNS)
    rows: list[list[str]]
    fills: list[list[str | None]] | None = None

    @model_validator(mode="after")
    def _check(self) -> "ExportRequest":
        width = len(self.headers)
        if any(len(r) != width for r in self.rows):
            raise ValueError("Mỗi dòng phải có số ô bằng số cột")
        if self.fills is not None:
            if len(self.fills) != len(self.rows) or any(len(f) != width for f in self.fills):
                raise ValueError("Ma trận màu phải cùng kích thước với dữ liệu")
            if any(c is not None and not HEX_COLOR_RE.match(c) for f in self.fills for c in f):
                raise ValueError("Màu phải có dạng #RRGGBB")
        self.headers = [h[:MAX_CELL_CHARS] for h in self.headers]
        self.rows = [[c[:MAX_CELL_CHARS] for c in r] for r in self.rows]
        return self


@router.post("/export")
async def export_table(
    request: Request, body: ExportRequest, format: Literal["csv", "xlsx"] = Query("csv")
):
    if len(body.rows) > request.app.state.settings.max_rows:
        raise HTTPException(status_code=422, detail="Quá nhiều dòng để xuất")
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if format == "csv":
        content, media = to_csv(body.headers, body.rows), "text/csv; charset=utf-8"
    else:
        content, media = to_xlsx(body.headers, body.rows, body.fills), _XLSX_TYPE
    return Response(
        content=content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="jira_report_{stamp}.{format}"'},
    )
