# Jira Report

Web app chạy trên máy cá nhân để lọc issue trên Jira Server (REST API v2), xem bảng, nhóm/sắp xếp, xem dashboard 2 chiều, xuất CSV/Excel, copy bảng vào Excel/Google Sheets và xuất tin nhắn.

## Cài đặt nhanh (Windows, dành cho người không rành kỹ thuật)

Giải nén, bấm đúp **`CAI-DAT.bat`**, nhập địa chỉ Jira và dán PAT khi được hỏi (không có địa chỉ Jira nào được ghi sẵn trong source). Nếu máy chưa có Python 3.10+, script hỏi rồi tự cài giúp (winget, hoặc tải bộ cài chính thức từ python.org và kiểm tra chữ ký số; cài riêng cho user, không cần Admin), cài thư viện, tạo `.env`, tự chạy nền mỗi khi đăng nhập Windows và tạo shortcut **Jira Report** ngoài Desktop. Xem [HUONG-DAN.txt](HUONG-DAN.txt).

| File | Việc |
|---|---|
| `CAI-DAT.bat` | Cài một lần (chạy lại để đổi PAT hoặc sửa môi trường hỏng) |
| `CAP-NHAT.bat` | Dừng app, `git pull` (nếu là git repo), cài thư viện mới, chạy lại |
| `GO-CAI-DAT.bat` | Dừng app, xoá shortcut tự chạy và Desktop |

Cách hoạt động: shortcut trong thư mục Startup của Windows chạy `.venv\Scripts\pythonw.exe run.py` (không cửa sổ, log ở `logs/app.log`); không cần quyền Admin. Mã các bước nằm ở `scripts/*.ps1`.

## Chạy thủ công (dành cho dev)

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env      # rồi điền JIRA_PAT vào .env
.venv\Scripts\python run.py
```

Mở http://127.0.0.1:8000

## Tạo Personal Access Token (PAT)

Jira → avatar → **Profile** → **Personal Access Tokens** → **Create token**. Dán token vào `JIRA_PAT` trong `.env`. Token chỉ nằm ở backend, không bao giờ gửi tới trình duyệt.

## Cấu hình (`.env`)

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `JIRA_BASE_URL` | URL Jira, ví dụ `https://jira.example.com` | bắt buộc |
| `JIRA_PAT` | Personal Access Token | bắt buộc |
| `MAX_ROWS` | Số dòng tối đa mỗi lần chạy | 5000 |
| `PAGE_SIZE` | Số issue mỗi lần gọi Jira | 100 |
| `PORT` | Cổng local | 8000 |
| `CA_BUNDLE` | Đường dẫn CA bundle nếu Jira dùng chứng chỉ nội bộ | trống |

## Giao diện

- **Thanh menu trên cùng** luôn hiện: chuyển Bảng / Dashboard, trạng thái kết nối, **Mở rộng** (ẩn bộ lọc để bảng/dashboard rộng hết màn hình, bấm **Thu nhỏ** hoặc Esc để quay lại), **Toàn màn hình** của trình duyệt, đổi giao diện **Sáng / Tối / Theo hệ thống**, và menu **Hồ sơ**.
- **Bộ lọc nằm ở thanh bên trái**, được lưu tự động (localStorage) và khôi phục khi mở lại; nút **Xóa bộ lọc** xóa toàn bộ.
- **Phân trang:** chọn số dòng mỗi trang (20 / 50 / 100 / 200 / 500), nhảy tới trang bất kỳ bằng ô số trang. Các dòng đã tích được nhớ khi đổi trang, đổi cỡ trang hoặc sắp xếp; thanh thao tác ở cuối bảng cho biết đã chọn bao nhiêu dòng và ở những trang nào, và **mọi thao tác xuất đều dùng đúng các dòng đó**.
- **Ngày giờ** hiển thị `dd/MM/yyyy` (có giờ thì thêm `HH:mm`) ở bảng, nhóm, dashboard, file xuất và tin nhắn; ô lọc ngày cũng nhập theo `dd/MM/yyyy` (gõ liền `01102026` sẽ tự thêm dấu `/`, hoặc bấm biểu tượng lịch). Sắp xếp và nhóm vẫn theo thời gian thật.
- Font Be Vietnam Pro được tải từ Google Fonts (không có kết nối thì tự dùng font hệ thống).

## Tính năng

**Bộ lọc** (nút thanh trượt ở đầu thanh bên chọn bộ lọc nào hiện):
project, sprint (hiện sau khi chọn project), label, reporter, assignee (gõ tên user **hoặc nhóm**, ví dụ nhóm `backend` → `membersOf("backend")`), ngày tạo, ngày cập nhật, status, issue type.

**Bộ lọc theo field Jira bất kỳ:** *+ Thêm bộ lọc theo field Jira* → chọn field, toán tử (theo kiểu dữ liệu), giá trị. Gợi ý giá trị lấy từ Jira khi có.

**Chế độ JQL:** bật công tắc để xem JQL do bộ lọc sinh ra và sửa tay. Tắt công tắc để chuyển ngược về bộ lọc; điều kiện không chuyển được (OR, hàm, sprint theo tên…) được liệt kê và bạn chọn ở lại hay bỏ.

**Bảng:**
- Cột STT, ô tích chọn (Shift+click chọn một dải), cột *Ghi chú* ghim bên phải (sửa trực tiếp, lưu trong hồ sơ).
- Key là link mở task trên Jira ở tab mới. Cột Comment chỉ hiện comment mới nhất.
- Sắp xếp nhiều cột: click tiêu đề = sắp xếp chính, Shift+click = thêm cột sắp xếp tiếp theo.
- Nhóm theo cột, nhiều cấp (tối đa 3). Cột nhiều giá trị (label, sprint) → issue nằm ở từng nhóm của nó. Cột ngày gom theo ngày/tuần/tháng.
- Tô màu theo status (nút *Màu status*): tô cả dòng hoặc chỉ ô Status. Màu mặc định theo nhóm trạng thái của Jira.

**Xuất / copy — chỉ các dòng được tích chọn**, theo đúng thứ tự đang hiển thị, kèm STT, Ghi chú (và cột *Nhóm* khi đang nhóm):
- *Xuất CSV* (không lưu màu) và *Xuất Excel* (có màu).
- *Copy bảng*: dán vào Excel/Google Sheets giữ nguyên màu.
- *Xuất tin nhắn*: mỗi dòng theo mẫu `{key}:{summary} ==> {note}` (sửa được mẫu; có `{status}`, `{url}`). Ghi chú trống vẫn giữ ` ==> `.

**Dashboard:** chọn trục X, Y bất kỳ (cột ngày chọn gom ngày/tuần/tháng), giá trị là số issue hoặc tổng một field số (story points…), dạng ma trận hoặc biểu đồ cột chồng. Click ô ma trận để xem các issue của ô đó trong bảng.

**Hồ sơ cá nhân:** cột đang chọn, bộ lọc tuỳ chỉnh, ẩn/hiện bộ lọc, màu status, mẫu tin nhắn và ghi chú được lưu tự động trong trình duyệt (`localStorage`). *Xuất hồ sơ* tải file JSON; *Nhập hồ sơ* nạp lại (ghi đè hoặc chỉ gộp ghi chú). Backend không lưu gì.

Nếu kết quả vượt `MAX_ROWS`, app báo "bị cắt bớt": thu hẹp bộ lọc hoặc tăng `MAX_ROWS`.

## Bảo mật

- Server chỉ lắng nghe `127.0.0.1`, không có đăng nhập riêng; không đổi sang `0.0.0.0`.
- Bộ lọc và tên field được dựng từ metadata của Jira và escape khi sinh JQL; chế độ JQL là JQL của chính bạn, chạy bằng quyền của PAT.
- Ô bắt đầu bằng `= + - @` được vô hiệu hoá công thức khi xuất file. Dữ liệu Jira luôn hiển thị bằng `textContent`.
- Ghi chú chỉ lưu cục bộ, không ghi ngược vào Jira.
- Không commit `.env`.

## Test

```powershell
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest          # backend
npm test                                  # logic JS (cần Node 20+): node --test "webtests/*.test.mjs"
```

Chạy giao diện với dữ liệu giả (không cần Jira/PAT) để kiểm tra bằng mắt:

```powershell
.venv\Scripts\python -m tests.dev_server   # http://127.0.0.1:8766 (đổi cổng: DEV_PORT=8791)
```

## Giấy phép

MIT, xem [LICENSE](LICENSE). Mã nguồn: https://github.com/Quan2210/JiraReporterTools
