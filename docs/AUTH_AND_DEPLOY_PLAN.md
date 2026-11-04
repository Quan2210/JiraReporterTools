# Đăng nhập Jira + public app — Đề xuất & kế hoạch

> Trạng thái: **ĐỀ XUẤT, chưa triển khai.** Cần user chốt các câu hỏi ở mục 7 trước khi code. Bối cảnh code hiện tại: [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Yêu cầu

- Bỏ `JIRA_PAT` trong `.env`; mỗi người dùng **đăng nhập bằng thông tin Jira của chính họ** rồi app mới gọi Jira thay mặt họ.
- Có thể **public lên mạng** (chia sẻ link) → phải coi mọi request là không tin cậy.

## 2. Ràng buộc quan trọng (đọc trước khi chọn giải pháp)

1. **Jira là Server/Data Center** (`/rest/api/2`, PAT Bearer, `jira.example.com`). Không có OAuth 2.0 "3LO" kiểu Jira Cloud. Chỉ có: PAT, Basic (user/password), OAuth 1.0a / OAuth 2.0 qua Application Link (cần admin Jira), hoặc SSO của công ty.
2. **Server app phải truy cập được Jira.** Nếu Jira chỉ nằm trong mạng nội bộ/VPN thì host public (VPS, Render, Fly...) sẽ không gọi được. Phải kiểm tra `jira.example.com` có reachable từ Internet không. Nếu không → chạy BE trong mạng công ty (hoặc cùng VPN) và chỉ expose qua tunnel/reverse proxy.
3. **Browser không gọi thẳng Jira được** (CORS + lộ token) → vẫn cần BE làm proxy. Không có phương án "thuần frontend".
4. App public = một proxy tới Jira công ty. Chỉ cho phép **một** `JIRA_BASE_URL` cố định do server cấu hình (không cho user nhập URL → tránh SSRF).

## 3. Cách đăng nhập (chọn)

| Phương án | Mô tả | Ưu | Nhược |
|---|---|---|---|
| **A. Dán PAT cá nhân (khuyến nghị)** | Form đăng nhập: user dán PAT của họ. BE gọi `/rest/api/2/myself` xác thực rồi tạo phiên | Không cần admin; không đụng mật khẩu; PAT thu hồi được trong Jira; quyền = quyền của user; sửa ít code nhất | User phải tự tạo PAT; app giữ PAT (phải mã hoá) |
| B. Username + password (Basic) | Form user/pass → Basic auth | UX quen | App chạm mật khẩu thật; thường bị chặn nếu có SSO/2FA; rủi ro cao khi public → **không khuyến nghị** |
| C. OAuth qua Application Link | Redirect sang Jira để đồng ý | Chuẩn nhất, không ai dán secret | Cần admin Jira tạo link + key; OAuth1.0a ký phức tạp; tốn công nhất |

→ Làm **A** trước; thiết kế tầng auth theo interface để sau này thêm C mà không đụng router.

## 4. Thiết kế phiên (session) cho phương án A

- `POST /api/auth/login {pat}` → gọi `GET /rest/api/2/myself` bằng PAT đó (kiểm tra hợp lệ, lấy `name/displayName`) → tạo phiên → set cookie.
- `POST /api/auth/logout` → huỷ phiên, xoá cookie. `GET /api/auth/me` → `{user}` hoặc 401 (thay vai trò `/api/health` cho UI).
- Cookie: `HttpOnly; Secure; SameSite=Lax` (hoặc `__Host-` prefix), TTL ngắn (vd 8h, sliding), tuyệt đối tối đa 24h.
- **Lưu PAT ở đâu** (chọn một):
  - **S1 — Cookie mã hoá không trạng thái (Fernet/AES-GCM, khoá `SESSION_SECRET` trên server):** không cần DB, scale ngang dễ, restart không mất phiên. Nhược: không thu hồi tức thì từng phiên (đổi khoá = đăng xuất tất cả), PAT nằm trong cookie (đã mã hoá, ~100–200 byte).
  - **S2 — Session phía server (RAM/SQLite/Redis) + PAT mã hoá at-rest:** cookie chỉ chứa session id ngẫu nhiên 256-bit; thu hồi/đăng xuất tức thì; PAT không rời server. Cần kho lưu (RAM thì mất khi restart; 1 instance thì SQLite/Redis là đủ).
  - Khuyến nghị: **S2 với SQLite** (hoặc RAM nếu chấp nhận đăng nhập lại sau restart) — đơn giản, an toàn hơn S1, đủ cho quy mô nhỏ. Dùng S1 nếu muốn zero-storage.
- **Không bao giờ** ghi PAT vào log, response, URL, localStorage. Giữ nguyên test `test_pat_never_in_responses_or_logs`, mở rộng cho PAT từng user.

## 5. Thay đổi code cần làm (backend)

1. `config.py`: bỏ `JIRA_PAT` khỏi bắt buộc; thêm `SESSION_SECRET` (bắt buộc khi production), `COOKIE_SECURE`, `SESSION_TTL`, `ALLOWED_ORIGINS/HOSTS`, `ALLOWED_JIRA_USERS` (tuỳ chọn allowlist).
2. `jira_client.py`: tách thành `JiraHttp` dùng chung (httpx.AsyncClient, pool, retry) + lời gọi nhận `token` **theo từng request** (`headers={"Authorization": f"Bearer {pat}"}`), không gắn vào client chung.
3. `cache.py`: key bắt buộc có **user** (hoặc hash PAT/username): `f"{username}:fields"`. Thêm giới hạn kích thước/LRU và xoá cache của user khi logout.
4. Module mới `app/auth.py`: store phiên, `Depends(current_user)` trả `(user, pat)`; router `routers/auth.py` (login/logout/me).
5. Gắn `Depends(current_user)` cho **tất cả** `/api/*` trừ `/api/auth/login`; `/api/export` cũng nên yêu cầu đăng nhập (chống bị lạm dụng làm máy xuất file).
6. `main.py`: bỏ client/cache toàn cục theo PAT; giữ một `httpx` pool dùng chung; handler `JiraAuthError` khi đang có phiên → xoá phiên + 401 để UI quay về trang đăng nhập.
7. `run.py`: đọc `HOST` từ env (mặc định `127.0.0.1`; production đứng sau reverse proxy). Cập nhật `test_server_binds_loopback_only` cho phù hợp (mặc định vẫn loopback).
8. Bảo vệ khi public:
   - HTTPS bắt buộc (TLS ở reverse proxy), HSTS.
   - **Rate limit** đăng nhập (theo IP + theo user; vd 5 lần/phút) và rate limit `/api/report/query` (truy vấn nặng, tối đa 5000 dòng); giới hạn đồng thời mỗi user.
   - **CSRF**: SameSite=Lax + kiểm tra `Origin`/`Host` cho POST (hoặc header tuỳ biến `X-Requested-With`). Vẫn **không bật CORS**.
   - Security headers: CSP (`default-src 'self'`, cho phép Google Fonts hoặc tự host font), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`.
   - Không lộ chi tiết lỗi nội bộ; thông báo đăng nhập sai chung chung.
   - Tắt `/docs` (đã tắt). Log truy cập không chứa cookie/PAT.
   - Giới hạn body size, timeout; `MAX_ROWS` theo user.
   - Tuỳ chọn: allowlist user Jira / nhóm Jira được phép; trang giới thiệu có cảnh báo "PAT chỉ nên cấp quyền đọc".

## 6. Thay đổi frontend

- Thêm màn hình đăng nhập (ô dán PAT + hướng dẫn tạo PAT) hiển thị khi `/api/auth/me` trả 401; nút Đăng xuất ở topbar thay pill "Đã kết nối".
- `api.js`: khi nhận 401 → hiện màn đăng nhập (xoá state nhạy cảm trong RAM).
- `store.js`: đổi key localStorage thành `jira-report-profile:<username>` để nhiều tài khoản chung trình duyệt không lẫn ghi chú/profile (có migration từ key cũ).
- Không lưu PAT ở client; xoá ô nhập sau khi gửi.

## 7. Phương án dựng / triển khai BE

| | Mô tả | Khi nào chọn |
|---|---|---|
| **Giữ FastAPI (khuyến nghị)** | Thêm lớp auth/session như trên; đóng gói Docker; uvicorn (nhiều worker nếu dùng Redis/SQLite) sau **Caddy/Nginx** (TLS tự động) | Đã có đủ code BE, async httpx hợp với proxy I/O; thay đổi nhỏ nhất, giữ nguyên toàn bộ test |
| Đổi sang Node (NestJS/Express) hoặc .NET | Viết lại BE | Chỉ khi team muốn đồng nhất stack; tốn công, **không** có lợi kỹ thuật cho bài toán này |
| Serverless (Cloud Run/Lambda) | Scale-to-zero | Cần session store ngoài (Redis/Firestore); cold start; chỉ hợp nếu Jira reachable từ cloud |

Hạ tầng gợi ý (quy mô nhỏ): 1 VPS nhỏ hoặc Fly.io/Render/Cloud Run + Docker, Caddy lo HTTPS, SQLite/Redis cho phiên, biến môi trường cho secret. Nếu Jira nằm sau VPN: chạy container trong mạng công ty và expose bằng Cloudflare Tunnel (hoặc để chỉ truy cập nội bộ).

### Câu hỏi cần user chốt

1. `jira.example.com` truy cập được từ Internet không, hay chỉ trong VPN/nội bộ? (quyết định host đâu)
2. "Public lên mạng xã hội" = ai cũng thử đăng nhập được (cần rate limit, allowlist), hay chỉ đồng nghiệp có tài khoản Jira? Có muốn allowlist theo nhóm Jira?
3. Chấp nhận phương án A (dán PAT cá nhân)? Hay cần SSO/OAuth (cần admin Jira)?
4. Lưu phiên: RAM (đơn giản, mất khi restart) / SQLite / Redis?
5. Nơi deploy dự kiến (VPS, Fly, Render, on-prem)?

## 8. Lộ trình triển khai đề xuất

1. **Auth core** (BE): `auth.py`, store phiên, login/logout/me, `Depends` cho mọi router, client nhận token theo request, cache theo user. Cập nhật test (fixture đăng nhập, test 401, test cô lập cache giữa 2 user, test PAT không lộ).
2. **Frontend login** + đổi key profile theo user.
3. **Hardening**: rate limit, CSRF/Origin, security headers, giới hạn đồng thời, `HOST` cấu hình.
4. **Đóng gói**: Dockerfile, docker-compose (app + Caddy), `.env.example` mới (không còn `JIRA_PAT`), README cập nhật.
5. **Triển khai & kiểm thử xuyên suốt** (đăng nhập sai, PAT hết hạn giữa phiên, 2 user cùng lúc, logout).

## 9. Rủi ro đã nhận diện

- Rò rỉ dữ liệu chéo user qua cache dùng chung (hiện tại là bug tiềm ẩn nếu chỉ bỏ PAT mà không sửa cache) — **ưu tiên sửa đầu tiên**.
- Lộ PAT (log, lỗi, cookie không mã hoá). Mitigation: mục 4, 5.
- Lạm dụng làm proxy/scraper Jira, brute-force PAT: rate limit + allowlist.
- JQL tay chạy bằng quyền của user (đúng ý) — nhưng cần giới hạn tải để một user không làm nghẽn Jira công ty.
- Jira bất khả dụng/chậm kéo theo worker bị treo: giữ timeout hiện có, thêm giới hạn đồng thời.
