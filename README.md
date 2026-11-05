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
| `SLACK_WEBHOOK_URL` | Incoming Webhook của Slack (nhắc nhở), phải bắt đầu bằng `https://hooks.slack.com/services/` | trống |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram (nhắc nhở), lấy từ `@BotFather` | trống |
| `REMINDER_CATCHUP_MINUTES` | Quá giờ hẹn bao nhiêu phút thì nhắc nhở bị bỏ (ghi "lỡ giờ") thay vì gửi bù | 120 |
| `REMINDER_HISTORY_DAYS` | Số ngày giữ lịch sử gửi; cũ hơn thì được dọn tự động mỗi ngày | 30 |

## Nhắc nhở theo lịch (Slack, Telegram)

Tab **Nhắc nhở** (cạnh Bảng và Dashboard) liệt kê các job nhắc nhở: tên, lịch, kênh, trạng thái (*Đang bật / Tắt / Đã xong*), lần chạy kế tiếp và lần chạy gần nhất.

- **Thêm:** chọn bộ lọc ở thanh bên trái rồi bấm **Thêm nhắc nhở**. Chọn kênh, **tiêu đề tin**, mẫu mỗi dòng, số dòng tối đa và điều kiện *chỉ gửi khi có issue*.
  - **Tiêu đề tin** (dòng đầu): biến `{name}` (tên nhắc nhở), `{count}` (số issue), `{date}` (ngày hôm nay, dd/MM/yyyy). Để trống thì dùng `{name} ({count} issue)`.
  - **Mẫu mỗi dòng:** gõ `{` để app gợi ý danh sách cột Jira (mũi tên + Enter/Tab, hoặc bấm chọn), hoặc bấm nút **+** bên phải ô để mở danh sách có ô tìm và chèn vào vị trí con trỏ. Dùng được `{key}` `{summary}` `{status}` `{url}` và **mọi field Jira** theo mã field, ví dụ `{assignee}`, `{reporter}`, `{created}`, `{labels}`, `{customfield_10111}`; app tự tải thêm các cột đó khi chạy. Biến không tồn tại được giữ nguyên chữ. `{note}` không dùng được vì ghi chú nằm trong trình duyệt.
- **Quy tắc ghi chú:** mở mục *Quy tắc ghi chú* trong form. Mỗi issue được so với các quy tắc từ trên xuống, **quy tắc đầu tiên khớp được dùng**. Một quy tắc gồm: field (mặc định Status, giá trị gợi ý từ danh sách status của Jira), phép so sánh (*là / không phải / chứa / trống / có giá trị*), giá trị (nhiều giá trị cách nhau bằng dấu phẩy) và hành động: **Ghi chú** (điền nội dung vào biến `{note}`, nội dung dùng được biến như `{assignee}`) hoặc **Ẩn dòng** (bỏ issue khỏi tin và khỏi số đếm). Issue không khớp quy tắc nào dùng *ghi chú mặc định* (mục "Còn lại"). Nhớ đặt `{note}` trong mẫu mỗi dòng, ví dụ `{key}:{summary} ==> {note}`. Ví dụ: *Status là Done → "Done pilot"*, *Status là Testing, In review → "Đang kiểm thử"*, *Assignee trống → "Chưa có người xử lý"*.
- **Nhóm và sắp xếp:** *Nhóm theo* một field (Status, Assignee...), mỗi nhóm có dòng tiêu đề `▸ Tên (số issue)`, nhóm xếp theo tên hoặc theo số issue; *Sắp xếp theo* một field tăng hoặc giảm dần (số sắp theo giá trị số, ngày theo thời gian thật, ô trống luôn xuống cuối). Số dòng tối đa tính chung cho cả tin.
- **Điều kiện gửi:** *Luôn gửi*, *Khi có issue*, *Từ N issue trở lên*, *Khi danh sách thay đổi* (so với lần gửi theo lịch trước, tính theo mã issue + status; lần đầu luôn gửi) hoặc *Khi có issue khớp quy tắc*. Số issue ở đây tính sau khi ẩn dòng. Không đủ điều kiện thì lần chạy ghi *Bỏ qua* kèm lý do trong Lịch sử. *Gửi thử* luôn gửi, bỏ qua điều kiện. Khi bấm Xem trước, app cho biết tin có được gửi hay không.
- **Tự viết tin (nhắc nhở một lần):** với *Một lần*, bấm icon bút ở phần Xem trước để sửa tay nội dung. Tin được gửi **đúng nguyên văn** bạn viết: không chạy bộ lọc, không dùng mẫu, quy tắc hay điều kiện. Bấm lại icon bút để bỏ tin viết tay.
- **Lịch:** *Lặp theo tuần* (chọn các ngày + giờ) hoặc *Chỉ gửi một lần* (chọn ngày giờ, mặc định là giờ tròn kế tiếp hôm nay). Nhắc nhở một lần phải đặt ở tương lai; gửi xong thì tự chuyển sang **Đã xong** (kể cả khi gửi lỗi hoặc lỡ giờ, xem lý do ở *Lịch sử*). Muốn gửi lại thì sửa, đặt giờ mới rồi bật.
- **Xem chi tiết:** double-click một dòng (hoặc chọn rồi nhấn Enter). **Tác vụ:** chuột phải (hoặc phím Menu / Shift+F10) hoặc các nút icon trên thanh công cụ (rê chuột để xem tên): Xem chi tiết, Sửa, Gửi thử, Bật/Tắt, Nhân bản, Lịch sử, Xóa.
- **Xóa nhiều:** tích ô vuông ở đầu mỗi dòng (Shift+click để tích một dải, ô trên cùng để tích tất cả, phím Space để tích dòng đang chọn), rồi bấm icon thùng rác ở thanh "đã chọn", phím Delete hoặc chuột phải. Cột `#` là số thứ tự.
- **Đổi bộ lọc của một job:** mở form Sửa, bấm icon phễu để lấy lại bộ lọc hiện tại ở thanh bên trái, hoặc icon `</>` để sửa trực tiếp bằng JQL (bộ lọc cấu trúc được đổi thành JQL; ngày động trở thành ngày cố định, nên dùng JQL tương đối như `created >= -7d`).
- **Chạy thử, không cần đợi tới giờ:** trong form có **Xem trước** (không gửi) và **Gửi thử ngay** (gửi thật bằng cấu hình đang nhập, chưa cần lưu, tiêu đề có "[Gửi thử]", không ghi lịch sử). Nút **Gửi thử** ở từng job gửi theo cấu hình đã lưu và có ghi lịch sử.
- **Chạy trên máy này, khi app đang mở.** Máy tắt hoặc ngủ qua giờ hẹn: nếu bật lại trong vòng `REMINDER_CATCHUP_MINUTES` (mặc định 120 phút) thì gửi bù, quá thì ghi "lỡ giờ" trong lịch sử, không gửi.
- Lịch và lịch sử lưu ở `data/reminders.db` (không commit). Mỗi giờ hẹn gửi **tối đa một lần**. Lịch sử cũ hơn `REMINDER_HISTORY_DAYS` ngày (mặc định 30) được dọn mỗi ngày; lần chạy mới nhất của mỗi job luôn được giữ.
- **Ngày động:** ở các ô ngày của bộ lọc (Ngày tạo, Ngày cập nhật) bấm nút ⟳ để chuyển sang *Hôm nay*, *Trước hôm nay N ngày* hoặc *Sau hôm nay N ngày* (tối đa 3660). Giá trị được lưu dạng `today`, `today-7`, `today+3` và **tính lại ngày thật mỗi lần chạy** (báo cáo, nhắc nhở), nên "7 ngày gần nhất" luôn đúng. "Hôm nay" là ngày của máy chạy app; quanh nửa đêm có thể lệch một ngày nếu múi giờ của Jira khác. Ngày cố định và sprint chọn cố định thì không tự trượt (form nhắc nhở có cảnh báo); với sprint dùng JQL `openSprints()`.
- **Slack:** tạo Slack app, bật *Incoming Webhooks*, *Add New Webhook to Workspace* và chọn kênh (hoặc chính bạn để nhận DM), dán URL vào `SLACK_WEBHOOK_URL`. Workspace có thể yêu cầu admin duyệt app.
- **Telegram:** cần một bot riêng, xem hướng dẫn chi tiết ngay bên dưới. Mỗi người nên tạo bot riêng, không dùng chung token.
- Sửa `.env` xong cần khởi động lại app (`CAP-NHAT.bat` hoặc đăng xuất/đăng nhập).

### Lấy `TELEGRAM_BOT_TOKEN` (tạo bot Telegram)

Token là "mật khẩu" của **bot**, không phải của tài khoản Telegram của bạn. Bạn không cần biết token hay mật khẩu của người nhận tin; người nhận chỉ cần nhắn bot một lần.

1. Mở Telegram (điện thoại hoặc máy tính), tìm **`@BotFather`** (có dấu tích xanh xác minh) rồi bấm **Start**.
2. Gõ lệnh `/newbot`.
3. BotFather hỏi **tên hiển thị** của bot (tùy ý, ví dụ `Jira Report cua Quan`).
4. BotFather hỏi **username** của bot: phải **kết thúc bằng `bot`** và chưa ai dùng, ví dụ `quan_jira_report_bot`. Nếu báo trùng thì đổi tên khác.
5. BotFather trả về tin nhắn có dòng như sau, đoạn sau chữ `API:` chính là token:

   ```
   Use this token to access the HTTP API:
   123456789:AAExampleTokenExampleTokenExample
   ```

   Token có dạng `số:chuỗi-ký-tự`. Bấm giữ (hoặc chuột phải) để copy, đừng chụp màn hình hay gửi cho người khác.
6. Mở file `.env` ở thư mục gốc của app (nếu chưa có thì copy từ `.env.example`), thêm hoặc điền dòng:

   ```
   TELEGRAM_BOT_TOKEN=123456789:AAExampleTokenExampleTokenExample
   ```

   Không có dấu ngoặc kép, không có khoảng trắng thừa.
7. **Khởi động lại app** để nạp `.env` (`CAP-NHAT.bat`, hoặc đăng xuất rồi đăng nhập Windows). Mở tab **Nhắc nhở**, dòng trên bảng phải ghi `Telegram: đã cấu hình`.

#### Lấy `chat_id` (nơi nhận tin)

Với tin nhắn riêng, `chat_id` chính là **user id** của người nhận (hai thứ là một). Telegram **không** cho bot gửi theo số điện thoại hay `@username` của người, chỉ gửi theo `chat_id`. Bot chỉ nhắn được cho người **đã mở bot và bấm Start (hoặc nhắn bot) trước**, hoặc nhóm **đã thêm bot vào**; thiếu bước này thì Telegram trả lỗi 403 dù `chat_id` đúng.

- **Nhận tin riêng:** người nhận tìm username bot trong Telegram, mở ra và bấm **Start** (hoặc gửi một tin bất kỳ). Họ có thể làm việc này trên máy hoặc điện thoại của họ, không cần ở cùng máy với bạn.
- **Nhận tin trong nhóm:** vào nhóm → thêm thành viên → chọn bot, rồi gửi một tin bất kỳ trong nhóm. Nhắc cho nhiều người một lúc thì nên dùng nhóm, vì không ai phải Start bot riêng. Nếu nhóm không hiện khi lấy `chat_id`, vào BotFather (`/mybots` → chọn bot → *Bot Settings* → *Group Privacy* → **Turn off**) rồi gửi thêm một tin trong nhóm.
- Trong app: tab **Nhắc nhở** → thêm hoặc sửa nhắc nhở → chọn kênh **Telegram** → bấm **Lấy chat_id** → chọn chat trong danh sách (hoạt động với mọi người đã nhắn bot, vì chỉ dựa vào token bot). App điền số `chat_id` giúp bạn (nhóm thường là số âm, ví dụ `-100123456789`).
- Nếu chưa thấy tên người đó trong danh sách, họ có thể nhắn cho `@userinfobot` (bot của bên thứ ba, không chính thức) để biết user id rồi bạn dán vào ô `chat_id`; họ vẫn phải Start bot của bạn.
- Bấm **Gửi thử ngay** trong form để kiểm tra tin có tới không.

#### Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Ghi `Telegram: chưa cấu hình` | Chưa có dòng `TELEGRAM_BOT_TOKEN=` trong `.env`, hoặc chưa khởi động lại app. |
| "Lấy chat_id" báo chưa thấy chat nào | Nhắn bot (hoặc nhắn trong nhóm có bot) một tin rồi bấm lại. Chỉ thấy được tin gần đây. |
| Gửi thử lỗi `Telegram: HTTP 401` | Token sai hoặc đã bị thu hồi. Lấy lại token (xem bên dưới) và sửa `.env`. |
| Gửi thử lỗi `Telegram: HTTP 400` hoặc `403` | `chat_id` sai, bạn chưa Start bot, hoặc bot bị đuổi khỏi nhóm. Nhắn bot lại rồi lấy lại `chat_id`. |
| Gửi thử lỗi `Telegram: lỗi mạng` | Máy không ra được Internet hoặc mạng công ty chặn `api.telegram.org`. Nếu mạng dùng chứng chỉ nội bộ, đặt `CA_BUNDLE` trong `.env`. |

**Lấy lại hoặc đổi token:** chat với `@BotFather` → `/mybots` → chọn bot → **API Token** (xem lại) hoặc **Revoke current token** (tạo token mới, token cũ ngừng hoạt động). Sau khi đổi, sửa lại `.env` và khởi động lại app. Nếu lỡ lộ token thì Revoke ngay.

## Giao diện

- **Thanh menu trên cùng** luôn hiện: chuyển Bảng / Dashboard / Nhắc nhở, trạng thái kết nối, **Mở rộng** (ẩn bộ lọc để bảng/dashboard rộng hết màn hình, bấm **Thu nhỏ** hoặc Esc để quay lại), **Toàn màn hình** của trình duyệt, đổi giao diện **Sáng / Tối / Theo hệ thống**, và menu **Hồ sơ**.
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
- Token Telegram và URL webhook Slack chỉ nằm trong `.env`: không trả về trình duyệt, không ghi vào log hay DB (log của `httpx` được hạ xuống WARNING vì URL chứa bí mật). PAT Jira không bao giờ được gửi tới Slack/Telegram.
- `/api/*` chỉ nhận request có `Host` là `127.0.0.1` / `localhost` / `[::1]` và `Origin` (nếu có) cùng nguồn, để một trang web bất kỳ không thể tạo hay gửi nhắc nhở qua trình duyệt của bạn.
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
