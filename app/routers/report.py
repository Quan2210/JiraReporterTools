from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.jql import build_jql
from app.jql_parse import parse_jql
from app.report_service import get_field_meta, run_query
from app.schemas import MAX_JQL_LEN, ReportQuery

router = APIRouter(prefix="/api")


class JqlParseRequest(BaseModel):
    jql: str = Field(min_length=1, max_length=MAX_JQL_LEN)


@router.post("/report/query")
async def query_report(request: Request, query: ReportQuery):
    s = request.app.state
    return await run_query(query, s.client, s.cache, s.settings)


@router.post("/jql/build")
async def jql_build(request: Request, query: ReportQuery):
    """The JQL a set of structured filters turns into (shown when switching to JQL mode)."""
    s = request.app.state
    return {"jql": build_jql(query, await get_field_meta(s.client, s.cache))}


@router.post("/jql/parse")
async def jql_parse(request: Request, body: JqlParseRequest):
    s = request.app.state
    return parse_jql(body.jql, await get_field_meta(s.client, s.cache))
