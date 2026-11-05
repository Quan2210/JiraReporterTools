# Jira Report — Kiến trúc hiện tại (as-is)

> Tài liệu cho các phiên làm việc sau. Phản ánh code tại commit `2f4f853` (main). Kế hoạch đăng nhập / public: xem [AUTH_AND_DEPLOY_PLAN.md](AUTH_AND_DEPLOY_PLAN.md).

## 1. Mục đích

Web app lọc issue trên **Jira Server/Data Center (REST API v2)**: bảng, nhóm/sắp xếp, dashboard 2 chiều, xuất CSV/Excel, copy bảng, xuất tin nhắn theo mẫu. Hiện chạy **cục bộ cho 1 người**; PAT nằm trong `.env` của server.

## 2. Stack

| Lớp | Công nghệ |
|---|---|
| Backend | Python, FastAPI, uvicorn, httpx (async), openpyxl, python-dotenv, pydantic |
| Frontend | Vanilla JS (ES modules, không build step, không framework), `static/index.html` + `style.css` |
| Test | pytest + respx (BE, `tests/`), `node --test` (logic JS thuần, `webtests/`) |
| Lưu trữ | Cache RAM (TTL 10 phút). Hồ sơ người dùng ở `localStorage` trình duyệt. **Duy nhất nhắc nhở** dùng SQLite (`data/reminders.db`, stdlib `sqlite3`, xem mục 13) |

## 3. Cấu trúc thư mục

```
run.py                  # uvicorn, host=127.0.0.1 (test_security kiểm tra điều này)
app/
  main.py               # create_app(settings, client): lifespan, exception handler, mount static
  config.py             # Settings (frozen dataclass) đọc .env; JIRA_PAT repr=False
  jira_client.py        # JiraClient (httpx.AsyncClient dùng chung, Bearer PAT), retry, map lỗi
  cache.py              # TTLCache (key->value, lock chống thundering herd)
  schemas.py            # ReportQuery, CustomFilter (pydantic, validate chặt)
  jql.py                # build_jql: filter có cấu trúc -> JQL (escape/quote)
  jql_parse.py          # parse_jql: JQL -> filter có cấu trúc (chiều ngược lại)
  normalizer.py         # issue Jira -> ô hiển thị (cells), xử lý sprint/date/comment/user...
  report_service.py     # run_query: phân trang search, comment fallback, trả rows
  exporter.py           # to_csv / to_xlsx (chống formula injection, màu ô)
  routers/meta.py       # /api/meta/*  (projects, fields, statuses, issuetypes, labels, users, groups, suggest, sprints)
  routers/report.py     # /api/report/query, /api/jql/build, /api/jql/parse
  routers/export.py     # /api/export?format=csv|xlsx  (KHÔNG gọi Jira)
  routers/reminders.py  # /api/reminders*, /api/channels* (xem mục 13)
  reminder_store.py / reminder_schedule.py / reminder_service.py / reminder_scheduler.py / channels.py / message.py
static/js/              # main.js (điều phối), filters.js, table.js, dashboard.js, actions.js, ...
static/js/lib/          # logic thuần, có unit test: group, pivot, sort, paging, dates, profile, ...
tests/                  # FakeClient (tests/fakes.py), dev_server.py chạy UI với dữ liệu giả
```

## 4. Luồng chạy

1. `app = create_app()` ở import time; `lifespan` tạo **một** `Settings`, **một** `JiraClient`, **một** `TTLCache` và gắn vào `app.state`.
2. Router lấy `request.app.state.client/cache/settings` (singleton toàn cục).
3. `JiraClient` gắn sẵn header `Authorization: Bearer <JIRA_PAT>` cho mọi request tới `JIRA_BASE_URL`.
4. Trình duyệt: `main.js` → `GET /api/health` (gọi `/rest/api/2/myself`, hiện "Đã kết nối: <user>") → `loadMeta()` (projects/fields/statuses/issuetypes) → khôi phục profile từ localStorage.
5. "Chạy báo cáo": `POST /api/report/query` (ReportQuery) → `run_query`: kiểm tra cột ∈ field meta → `build_jql` (hoặc JQL tay) → lặp `POST /rest/api/2/search` theo `PAGE_SIZE` tới `MAX_ROWS` → `normalize_issue` → trả `{columns, rows, total, truncated, jql}`.
6. Sắp xếp / nhóm / phân trang / dashboard / chọn dòng **chạy hoàn toàn ở client**. Xuất file: client gửi bảng đã dựng (headers, rows, fills) tới `/api/export`; BE chỉ render file.

## 5. API nội bộ (tất cả hiện KHÔNG yêu cầu xác thực)

| Method | Path | Gọi Jira? |
|---|---|---|
| GET | `/api/health` | `/myself` |
| GET | `/api/meta/projects` `fields` `statuses` `issuetypes` | có (cache 10') |
| GET | `/api/meta/labels` `users` `groups` `suggest` | có (không cache) |
| GET | `/api/meta/sprints?project=` | agile boards + sprints (cache) |
| POST | `/api/report/query` | `/search` (nhiều trang) |
| POST | `/api/jql/build`, `/api/jql/parse` | chỉ cần field meta |
| POST | `/api/export?format=` | không |
| GET/POST/PUT/DELETE | `/api/reminders[/{id}]` | không (chỉ SQLite) |
| POST | `/api/reminders/preview`, `/api/reminders/{id}/test`, `/api/reminders/send-test` | có (`/search`) + gửi Slack/Telegram (`/test`, `/send-test`; `/send-test` dùng dữ liệu form, không ghi lịch sử) |
| GET | `/api/reminders/{id}/runs`, `/api/channels` | không |
| POST | `/api/channels/telegram/chats` | Telegram `getUpdates` |
| * | `/` | static |

Mọi `/api/*` đi qua middleware `local_only_guard` (mục 13). Không có xác thực người dùng. File tĩnh được trả kèm `Cache-Control: no-cache` (UI là các ES module import lẫn nhau; module cũ trong cache cạnh module mới làm hỏng trang).

Lỗi Jira được map trong `main.py`: `JiraError` → `{"detail": ...}` với status 401/403/404/422/502.

## 6. Cấu hình `.env`

`JIRA_BASE_URL` (bắt buộc), `JIRA_PAT` (bắt buộc), `MAX_ROWS`=5000, `PAGE_SIZE`=100, `PORT`=8000, `CA_BUNDLE` (CA nội bộ). `.env` bị gitignore. Nhắc nhở thêm (đều tùy chọn): `SLACK_WEBHOOK_URL` (phải bắt đầu bằng `https://hooks.slack.com/services/`), `TELEGRAM_BOT_TOKEN`, `REMINDER_CATCHUP_MINUTES`=120, `REMINDER_HISTORY_DAYS`=30. **Không đọc/in giá trị `.env` khi làm việc** (chứa PAT thật và các bí mật kênh).

## 7. Các thuộc tính bảo mật hiện có (phải giữ)

- Frontend không bao giờ nhận PAT (`test_static_files_do_not_contain_pat...`).
- PAT không xuất hiện trong response/log (`test_pat_never_in_responses_or_logs`).
- Bind loopback, không CORS (`test_server_binds_loopback_only`, `test_no_cors_middleware`).
- Giá trị filter được `quote()` khi sinh JQL; tên cột/field validate regex; JQL tay giới hạn 5000 ký tự, cấm ký tự điều khiển.
- Export neutralise công thức (`= + - @`), giới hạn cột/ô/dòng.
- Dữ liệu Jira hiển thị bằng `textContent` (chống XSS).
- Token Telegram / webhook Slack: chỉ ở `.env`, không vào response, log, DB, `static/` (`tests/test_reminders_api.py`); logger `httpx`/`httpcore` hạ xuống WARNING vì URL chứa bí mật; lỗi kênh chỉ lưu mã HTTP / tên lớp lỗi. PAT Jira không bao giờ đi tới kênh (client HTTP riêng, không có header `Authorization`).
- `local_only_guard` cho `/api/*`: Host phải thuộc `{127.0.0.1, localhost, [::1]}` (mọi cổng; chống DNS rebinding) và `Origin` nếu có phải trùng `Host` (chống trang web lạ gọi API có tác dụng phụ). Test dùng `testserver` qua fixture trong `tests/conftest.py`, không nới guard của bản chạy thật.
- Giả định ngầm: **chỉ một người dùng tin cậy** dùng app → đây chính là thứ phải đổi khi public.

## 8. Điểm "single-tenant" cần sửa khi làm đa người dùng

| Vị trí | Vấn đề |
|---|---|
| `main.py` lifespan: `app.state.client` | PAT cố định cho cả server |
| `JiraClient.__init__` | Header Bearer gắn vào client dùng chung |
| `app.state.cache` (`TTLCache`) | Key không có user; `projects`, `fields`, `sprints` phụ thuộc quyền từng user → rò rỉ dữ liệu chéo user |
| `routers/*` | Không có dependency xác thực |
| `/api/health` | Dùng làm "ping kết nối", chưa phải login |
| `run.py` | Bind `127.0.0.1` + test khẳng định điều đó |
| `static/js/store.js` | Key localStorage `jira-report-profile` không gắn theo user (ghi chú/profile có thể lẫn khi nhiều tài khoản chung 1 trình duyệt) |
| `tests/` | `conftest.settings` có `jira_pat`; `FakeClient` giả `JiraClient` |
| Nhắc nhở (mục 13) | Job nền dùng `JIRA_PAT` chung của server, `reminders` không có cột user. Khi làm đăng nhập từng người, job nền sẽ không có PAT của ai: phải lưu PAT mã hoá theo nhắc nhở hoặc dùng service account, và gắn `owner` vào bảng |

## 9. Lệnh thường dùng (Windows/PowerShell)

```powershell
.venv\Scripts\python run.py                 # chạy app (cần .env)
.venv\Scripts\python -m tests.dev_server    # UI với dữ liệu giả, port 8766
.venv\Scripts\python -m pytest              # test BE
npm test                                    # test logic JS (Node 20+)
```

## 10. Cài đặt & chạy nền trên Windows (cho người dùng không rành kỹ thuật)

- Bấm đúp ở thư mục gốc: `CAI-DAT.bat`, `CAP-NHAT.bat`, `GO-CAI-DAT.bat` → gọi `scripts/install.ps1`, `update.ps1`, `uninstall.ps1` (các script dùng chung `scripts/common.ps1`; `scripts/open.ps1` là đích của shortcut Desktop). File `.ps1` lưu UTF-8 **có BOM** để PowerShell 5.1 đọc đúng tiếng Việt; `.bat` chỉ chứa ASCII.
- Tự chạy khi đăng nhập: shortcut `Jira Report.lnk` trong thư mục Startup của user, trỏ `.venv\Scripts\pythonw.exe run.py` (WorkingDirectory = thư mục gốc để `.env` được nạp). Không dùng Task Scheduler/NSSM → không cần Admin.
- `run.py` chuyển stdout/stderr vào `logs/app.log` khi chạy bằng `pythonw` (không có console, nếu không uvicorn bị crash) và đọc `.env` theo đường dẫn tuyệt đối.
- Stop: `common.ps1::Stop-App` tìm PID đang nghe cổng `PORT` (đọc từ `.env`), chỉ kill nếu command line chứa `run.py`.
- `.venv` copy từ máy khác sẽ trỏ tới Python không tồn tại; `install.ps1` tự phát hiện và tạo lại.
- Thiếu Python: `install.ps1` hỏi người dùng (Enter = đồng ý) rồi cài bằng winget; nếu không có/thất bại thì tải `python-3.12.10` từ python.org, kiểm tra chữ ký số "Python Software Foundation", cài `/quiet InstallAllUsers=0 PrependPath=1`.
- Chưa test: hai nhánh cài Python và bước nhập/kiểm tra PAT (cần tương tác).

## 11. Icon

- `assets/logo.gif` (ảnh gốc, nền trắng) → `assets/logo.png` (đã tách nền, trong suốt) → `assets/icon.ico` (5 cỡ) dùng cho shortcut Desktop (`install.ps1`, tham số `-Icon`).
- Tab trình duyệt: `static/img/favicon.png|ico` là icon tĩnh; `static/js/favicon.js` phát `static/img/sticker.webm` (nền trong suốt) vào canvas và đổi `<link id="favicon">` mỗi 150 ms. Lỗi/không phát được thì giữ icon tĩnh.

- Địa chỉ Jira (`JIRA_BASE_URL`) **không có sẵn trong source** (`.env.example` để trống, tài liệu dùng `jira.example.com`): `install.ps1` hỏi người dùng cùng lúc với PAT và kiểm tra dạng URL; `config.py` yêu cầu có `https://`/`http://`.

## 12. Repository

Mã nguồn công khai tại https://github.com/Quan2210/JiraReporterTools (giấy phép MIT). Lịch sử git được làm mới (một commit khởi đầu) để không còn địa chỉ Jira nội bộ trong lịch sử; repo cũ không còn dùng.

## 13. Nhắc nhở theo lịch (Slack / Telegram bot)

Chạy trên máy người dùng, cho một người, không đăng nhập. Không thêm dependency (chỉ `sqlite3`, `asyncio`, `httpx`).

- **Luồng:** `create_app(scheduler=True)` (bản chạy thật: `app = create_app(scheduler=True)` trong `main.py`) → `lifespan` mở `ReminderStore`, tạo `ReminderService` + `ReminderScheduler`, chạy vòng lặp 30 giây. Mỗi tick: dọn lịch sử nếu quá 24 giờ chưa dọn; với mỗi nhắc nhở đang bật, `due_for()` tính slot → `begin_scheduled_run()` chiếm slot → task riêng (tối đa 3 chạy song song, timeout 120 giây) chạy `run_query` → `build_text` → gửi kênh → ghi `reminder_runs`.
- **Hai loại lịch (`schedule_kind`):**
  - `weekly`: `days` (thứ 2 = 0 … CN = 6) + `HH:MM` theo giờ máy (naive local time). Chỉ xét **một** slot gần nhất; trong `REMINDER_CATCHUP_MINUTES` thì chạy, quá thì ghi `missed`.
  - `once`: `run_at` (`YYYY-MM-DDTHH:MM`), phải ở tương lai lúc tạo / đổi / bật lại (422 nếu đã qua). Việc chiếm slot và **tắt nhắc nhở nằm trong cùng một giao dịch SQLite** (`begin_scheduled_run(..., disable_once=True)`, `record_missed(..., disable_once=True)`), nên app bị tắt giữa chừng không để lại nhắc nhở "bật mà không bao giờ chạy"; `init()` còn tự tắt các nhắc nhở `once` đã có run cho `run_at`.
  - Slot ≤ `active_since` bị bỏ qua; `active_since` đặt lại khi tạo, đổi lịch (`days`/`time`/`run_at`/`schedule_kind`), hoặc chuyển từ tắt sang bật, nên sửa lịch không bắn ngay.
- **Trạng thái (`state`, do store tính):** `active` (đang bật), `done` (`once`, đã tắt và có run `scheduled` đúng `run_at` hiện tại), `off` (còn lại). Run `manual` (Gửi thử) không làm thành `done`; đổi `run_at` thì hết `done`. `next_run` do router tính bằng `reminder_schedule.next_run`.
- **Không gửi trùng:** chỉ mục duy nhất một phần `UNIQUE(reminder_id, scheduled_for) WHERE kind='scheduled'`; slot được chiếm *trước* khi gửi. Đổi lại là "tối đa một lần": app tắt giữa lúc gửi thì run `running` bị đánh dấu `failed` khi khởi động và không gửi lại. "Gửi thử" là `kind='manual'`, không chiếm slot.
- **SQLite:** `data/reminders.db` (tuyệt đối từ thư mục gốc dự án; `create_app(reminder_db_path=...)` cho test và dev server), WAL, một kết nối ngắn cho mỗi thao tác trong `asyncio.to_thread`. Bảng `reminders` (bộ lọc `query_json`, kênh, `telegram_chat_id`, `schedule_kind`, `run_at`, lịch, điều kiện `always|only_if_results`, `max_lines`, `active_since`) và `reminder_runs`. Migration: `init()` thêm cột `schedule_kind`/`run_at` nếu DB cũ chưa có. Tối đa 50 nhắc nhở.
- **Dọn lịch sử:** `prune_history(days, now)` xóa run cũ hơn `REMINDER_HISTORY_DAYS` (30) ngày, chạy ở tick đầu tiên rồi mỗi 24 giờ. Không xóa run `running`, **run mới nhất của mỗi nhắc nhở**, và run làm nhắc nhở `once` thành `done`. Giới hạn 200 run mỗi nhắc nhở vẫn còn như lớp an toàn. Xóa lịch sử cũ không gây gửi trùng vì chỉ slot gần nhất mới được xét.
- **Bộ lọc đã lưu và ngày động:** `ReportQuery` chấp nhận ở bốn trường ngày các token `today`, `today-N`, `today+N` (N ≤ `MAX_DATE_OFFSET_DAYS` = 3660; hằng này có bản sao ở `static/js/lib/dates.js`), được đổi thành ngày thật *mỗi lần dựng model* (mỗi lần chạy báo cáo hoặc nhắc nhở) bằng ngày của máy; `jql.py` vẫn chỉ nhận `date`. Nhắc nhở lưu `query` qua `query_for_storage()`: chỉ giữ khóa hợp lệ của `ReportQuery`, giữ nguyên token, tối đa 32 KB. Hồ sơ trình duyệt (`profile.js`) cũng giữ token.
- **Kênh (`channels.py`):** Slack POST webhook (escape `& < >` để dữ liệu Jira không tạo mention); Telegram `sendMessage` không `parse_mode`, tách tin theo dòng ở 4096 ký tự; `getUpdates` để dò `chat_id`. Lỗi mạng/5xx/429 thử lại một lần sau 30 giây (trừ "gửi thử ngay"), 4xx không thử lại. Webhook và token **chỉ** đến từ `.env`, request không thể đưa URL tùy ý vào (không có SSRF).
- **Quy tắc ghi chú, nhóm, điều kiện (`app/note_rules.py`, `app/reminder_service.py`):** `note_rules` là danh sách `{field, op, values, action, text}` (tối đa 20; `op` ∈ in/not_in/contains/empty/not_empty; `action` ∈ note/hide), xét từ trên xuống, quy tắc đầu tiên khớp thắng; `evaluate()` trả các `Entry(row, note, matched)` và số dòng bị ẩn; `default_note` cho dòng không khớp; ghi chú được dựng bằng `render_line` nên dùng được biến. `arrange()` gom nhóm (`group_by`, `group_order` name|count) và sắp xếp (`sort_by`, `sort_dir`; số theo giá trị số, ngày theo `row.raw` ISO, ô trống cuối). `build_text` đặt dòng tiêu đề, dòng nhóm `▸ tên (n)`, các dòng issue (giới hạn `max_lines` chung) và `… và N issue nữa`. `fields_used()` + `_columns()` thêm vào truy vấn mọi field mà mẫu, ghi chú, quy tắc, nhóm, sắp xếp nhắc tới (chỉ field có trong meta Jira, tối đa 30). Điều kiện (`condition` ∈ always|only_if_results|min_count|if_changed|if_rule, `min_count`) do `skip_status()` quyết định: `skipped_empty`, `skipped_condition`, `skipped_unchanged`; `if_changed` so `prepared.signature` (sha256 của các cặp key|status sau khi ẩn) với cột `last_signature`, được ghi sau mỗi lần gửi **theo lịch** thành công (gửi thử không đổi mốc này). `custom_message` (chỉ `schedule_kind='once'`; API bỏ nếu là weekly) được gửi nguyên văn, không truy vấn Jira, không áp điều kiện. Xem trước (`POST /api/reminders/preview`) trả thêm `hidden`, `matched` và `decision {send, reason}`. Các cột mới được `init()` thêm bằng bảng `MIGRATIONS` cho DB cũ.
- **Gửi thử ngay (`POST /api/reminders/send-test`):** body là `ReminderCore` (cùng validator với `ReminderIn`, không có lịch), gửi tin kèm "[Gửi thử]", cùng timeout 120 giây, không retry, không ghi lịch sử.
- **Tin nhắn:** `app/message.py`. `render_line` là bản Python của `static/js/lib/message.js` (`{key} {summary} {status} {url}`) và mở rộng: mọi mã field Jira có trong `row["cells"]` (`{assignee}`, `{created}`, `{customfield_NNNNN}`...) cũng là biến; biến dựng sẵn thắng `cells`, biến lạ giữ nguyên chữ; `{note}` luôn rỗng vì ghi chú nằm trong `localStorage`. `render_title` dựng dòng đầu từ cột `title` (NULL = `{name} ({count} issue)`; biến `{name} {count} {date}`). `ReminderService._columns()` lấy các placeholder trong mẫu, giữ lại những mã có trong field meta của Jira (tối đa 30) và thêm vào `columns` của query, nên chỉ field được nhắc tới mới bị tải. Cột `title` do `init()` thêm cho DB cũ.
- **Frontend:** tab "Nhắc nhở" (`static/js/reminders.js`): bảng có cột checkbox và STT; hai khái niệm chọn tách biệt: dòng *hiện tại* (click / phím mũi tên; dùng cho thanh công cụ, menu, Enter) và các dòng *được tích* (checkbox / Shift+click / Space; dùng cho xóa nhiều). Double-click hoặc Enter = chi tiết, chuột phải hoặc Menu/Shift+F10 = menu tác vụ (trong một vùng đã tích nhiều dòng thì chỉ có "Xóa N đã chọn"), Delete = xóa. Nút là icon + tooltip (`aria-label`). Form thêm/sửa là dialog lớn 2 cột có nút X (cột trái: toàn bộ cấu hình; cột phải: chỉ vùng xem trước, cao bằng nội dung modal, có nút phóng to toàn màn hình, Esc thu nhỏ trước rồi mới đóng dialog; xem trước bị làm mờ khi tên, tiêu đề, mẫu hoặc bộ lọc đổi sau lần chạy gần nhất); ô tiêu đề và ô mẫu dùng `static/js/varpicker.js` (gõ `{` để gợi ý, nút + để chèn tại con trỏ; danh sách nằm trong `<dialog>` vì modal ở top layer; logic thuần `templateVariables`, `filterVariables`, `varTokenAt`, `completeVariable`, `insertVariable` trong `reminder-form.js`). Chọn dòng và tích ô đổi class tại chỗ, không dựng lại bảng, nếu không double-click không được trình duyệt ghi nhận (dòng bị thay giữa hai lần click); bộ lọc của job sửa lại bằng nút "lấy bộ lọc hiện tại" hoặc sửa JQL (`/api/jql/build` dựng JQL từ bộ lọc cấu trúc). `setMsg()` (toast) tự chuyển vào `<dialog>` đang mở vì modal nằm ở top layer. Logic thuần ở `static/js/lib/reminder-form.js` (`buildCore`, `buildPayload`, `reminderActions`, `duplicateDraft`...; test `webtests/reminder-form.test.mjs`). Ô ngày động: `static/js/datefield.js` (nút ⟳).
- **Test:** `tests/test_reminder_schedule.py`, `test_reminder_service.py`, `test_reminder_once.py`, `test_date_tokens.py`, `test_channels.py`, `test_message.py`, `test_reminders_api.py`. `conftest.py` có fixture autouse trỏ DB vào `tmp_path`, đặt retry về 0 và cho phép Host `testserver`.
- **Dev server:** `python -m tests.dev_server` dùng DB trong thư mục tạm; kênh không được cấu hình nên chỉ thử được tạo, sửa, xem trước, không gửi thật.
