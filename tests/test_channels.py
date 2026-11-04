import httpx
import pytest
import respx

from app.channels import ChannelError, send_slack, send_telegram, slack_escape, split_message, telegram_chats
from tests.conftest import FAKE_PAT, SLACK_URL, TG_TOKEN

TG_SEND = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"


def test_slack_escape_blocks_mentions():
    assert slack_escape("<!channel> a&b <@U1>") == "&lt;!channel&gt; a&amp;b &lt;@U1&gt;"


def test_split_message_boundaries():
    assert split_message("a" * 4096) == ["a" * 4096]
    parts = split_message("a" * 4097)
    assert [len(p) for p in parts] == [4096, 1]
    lines = "\n".join(["x" * 2000] * 3)
    parts = split_message(lines)
    assert all(len(p) <= 4096 for p in parts) and "\n".join(parts) == lines


@respx.mock
async def test_slack_posts_escaped_text_without_jira_pat():
    route = respx.post(SLACK_URL).mock(return_value=httpx.Response(200, text="ok"))
    async with httpx.AsyncClient() as http:
        await send_slack(http, SLACK_URL, "hi <!channel>")
    req = route.calls[0].request
    assert b"&lt;!channel&gt;" in req.content and FAKE_PAT not in str(req.headers)


@respx.mock
async def test_telegram_sends_plain_text_to_chat():
    route = respx.post(TG_SEND).mock(return_value=httpx.Response(200, json={"ok": True}))
    async with httpx.AsyncClient() as http:
        await send_telegram(http, TG_TOKEN, "-100123", "hello")
    body = route.calls[0].request.content
    assert b'"chat_id":"-100123"' in body.replace(b" ", b"") and b"parse_mode" not in body


@respx.mock
async def test_telegram_long_message_is_split():
    route = respx.post(TG_SEND).mock(return_value=httpx.Response(200, json={"ok": True}))
    async with httpx.AsyncClient() as http:
        await send_telegram(http, TG_TOKEN, "1", "\n".join(["y" * 3000] * 2))
    assert route.call_count == 2


@respx.mock
@pytest.mark.parametrize("status,retryable", [(400, False), (403, False), (429, True), (500, True)])
async def test_http_errors_are_classified_and_secret_free(status, retryable):
    respx.post(SLACK_URL).mock(return_value=httpx.Response(status, text=f"body {SLACK_URL}"))
    async with httpx.AsyncClient() as http:
        with pytest.raises(ChannelError) as ei:
            await send_slack(http, SLACK_URL, "x")
    assert ei.value.retryable is retryable
    assert "SECRETSLACKPART" not in str(ei.value)


@respx.mock
async def test_network_error_message_has_no_url():
    respx.post(TG_SEND).mock(side_effect=httpx.ConnectTimeout(f"timeout {TG_SEND}"))
    async with httpx.AsyncClient() as http:
        with pytest.raises(ChannelError) as ei:
            await send_telegram(http, TG_TOKEN, "1", "x")
    assert ei.value.retryable and TG_TOKEN not in str(ei.value)


@respx.mock
async def test_telegram_chat_discovery_dedupes():
    updates = {"ok": True, "result": [
        {"message": {"chat": {"id": 5, "type": "private", "first_name": "An", "last_name": "N"}}},
        {"message": {"chat": {"id": 5, "type": "private", "first_name": "An"}}},
        {"my_chat_member": {"chat": {"id": -100, "type": "supergroup", "title": "Team"}}},
    ]}
    respx.post(f"https://api.telegram.org/bot{TG_TOKEN}/getUpdates").mock(return_value=httpx.Response(200, json=updates))
    async with httpx.AsyncClient() as http:
        chats = await telegram_chats(http, TG_TOKEN)
    assert {c["id"] for c in chats} == {"5", "-100"}
