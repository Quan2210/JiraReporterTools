"""Outbound reminder channels: Slack incoming webhook and Telegram bot.

Secrets (the webhook URL, the bot token) appear in request URLs, so errors raised here carry only an HTTP status
or an exception class name - never a URL, a body, or str(exc).
"""
import httpx

TELEGRAM_LIMIT = 4096
SLACK_LIMIT = 39000


class ChannelError(Exception):
    """Safe-to-store message. `retryable` is True for network errors and 5xx/429."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


def slack_escape(text: str) -> str:
    """Slack treats & < > specially (<!channel>, <@U123>); Jira text must not trigger mentions."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def split_message(text: str, limit: int = TELEGRAM_LIMIT) -> list[str]:
    """Split on line boundaries; a single over-long line is cut hard."""
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:limit])
            line = line[limit:]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > limit:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current or not chunks:
        chunks.append(current)
    return chunks


async def _post(http: httpx.AsyncClient, name: str, url: str, payload: dict) -> httpx.Response:
    try:
        resp = await http.post(url, json=payload)
    except httpx.HTTPError as exc:
        raise ChannelError(f"{name}: lỗi mạng ({type(exc).__name__})", retryable=True) from None
    if resp.status_code >= 400:
        raise ChannelError(f"{name}: HTTP {resp.status_code}", retryable=resp.status_code >= 500 or resp.status_code == 429)
    return resp


async def send_slack(http: httpx.AsyncClient, webhook_url: str, text: str) -> None:
    await _post(http, "Slack", webhook_url, {"text": slack_escape(text)[:SLACK_LIMIT]})


async def send_telegram(http: httpx.AsyncClient, token: str, chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for chunk in split_message(text):
        # No parse_mode: Jira text is sent as plain text, so it can't inject formatting or links.
        await _post(http, "Telegram", url, {"chat_id": chat_id, "text": chunk or "(trống)", "disable_web_page_preview": True})


async def telegram_chats(http: httpx.AsyncClient, token: str) -> list[dict]:
    """Chats that recently talked to the bot (for picking a chat_id): private chats, groups, channels."""
    resp = await _post(http, "Telegram", f"https://api.telegram.org/bot{token}/getUpdates", {"limit": 100})
    try:
        updates = resp.json().get("result") or []
    except ValueError:
        raise ChannelError("Telegram: phản hồi không hợp lệ") from None
    found: dict[int, dict] = {}
    for update in updates:
        for key in ("message", "edited_message", "channel_post", "my_chat_member"):
            chat = (update.get(key) or {}).get("chat")
            if isinstance(chat, dict) and isinstance(chat.get("id"), int):
                title = chat.get("title") or " ".join(
                    p for p in (chat.get("first_name"), chat.get("last_name")) if p) or chat.get("username") or str(chat["id"])
                found[chat["id"]] = {"id": str(chat["id"]), "title": str(title)[:100], "type": str(chat.get("type", ""))}
    return list(found.values())
