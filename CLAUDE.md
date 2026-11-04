# Jira Report

FastAPI + vanilla JS app xem báo cáo Jira Server. **Đọc `docs/ARCHITECTURE.md` trước** (cấu trúc, luồng, điểm single-tenant), rồi `docs/AUTH_AND_DEPLOY_PLAN.md` (kế hoạch đăng nhập per-user + public, đang ở mức đề xuất).

- Không đọc/in `.env` (chứa PAT thật). Không commit `.env`.
- Giữ các test bảo mật trong `tests/test_security.py` (PAT không lộ, không CORS, export chống formula injection).
- Lệnh: `.venv\Scripts\python -m pytest`, `npm test`, `.venv\Scripts\python -m tests.dev_server`.
- Khi đổi kiến trúc/auth, cập nhật `docs/`.
