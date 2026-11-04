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
| Lưu trữ | **Không có DB.** Cache RAM (TTL 10 phút). Hồ sơ người dùng ở `localStorage` trình duyệt |

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
| * | `/` | static |

Lỗi Jira được map trong `main.py`: `JiraError` → `{"detail": ...}` với status 401/403/404/422/502.

## 6. Cấu hình `.env`

`JIRA_BASE_URL` (bắt buộc), `JIRA_PAT` (bắt buộc), `MAX_ROWS`=5000, `PAGE_SIZE`=100, `PORT`=8000, `CA_BUNDLE` (CA nội bộ). `.env` bị gitignore. **Không đọc/in giá trị `.env` khi làm việc** (chứa PAT thật).

## 7. Các thuộc tính bảo mật hiện có (phải giữ)

- Frontend không bao giờ nhận PAT (`test_static_files_do_not_contain_pat...`).
- PAT không xuất hiện trong response/log (`test_pat_never_in_responses_or_logs`).
- Bind loopback, không CORS (`test_server_binds_loopback_only`, `test_no_cors_middleware`).
- Giá trị filter được `quote()` khi sinh JQL; tên cột/field validate regex; JQL tay giới hạn 5000 ký tự, cấm ký tự điều khiển.
- Export neutralise công thức (`= + - @`), giới hạn cột/ô/dòng.
- Dữ liệu Jira hiển thị bằng `textContent` (chống XSS).
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
