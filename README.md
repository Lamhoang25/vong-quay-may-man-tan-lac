# 🎡 Vòng Quay May Mắn - Tân Lạc

Trò chơi vòng quay may mắn cho khách hàng trong nhóm Zalo. Node.js + Express, dữ liệu lưu trong file `data.json` (tự tạo).

## Chạy trên máy
```bash
npm install
npm start            # http://localhost:3000
```
- Trang người chơi: `/`  — Trang quản trị: `/admin`
- Mật khẩu quản trị mặc định: **admin123** → đổi bằng biến môi trường: `ADMIN_PASSWORD=matkhaucuaban npm start`
- Biến khác: `PORT` (mặc định 3000), `DATA_FILE` (đường dẫn file dữ liệu).

## Cách dùng mỗi tuần
1. Vào `/admin`, chỉnh các ô: tên, màu, **trọng số** (tỉ lệ trúng = trọng số / tổng trọng số). Bấm **Lưu**.
2. Gửi link trang chính vào nhóm Zalo.
3. Khách nhập Tên, SĐT, Làng → quay → chụp màn hình kết quả gửi cho shop.
4. Mỗi SĐT chỉ quay **1 lần mỗi vòng** (kiểm tra trên máy chủ).
5. Hết tuần: bấm **Đóng vòng**. Tuần mới: bấm **Bắt đầu tuần mới** → mọi người được quay lại, lịch sử vẫn giữ.
6. Xem thống kê, danh sách trúng thưởng, **Tải CSV** (mở được bằng Excel).

Kết quả do **máy chủ** chọn theo trọng số, khách không thể gian lận bằng trình duyệt.


## Lưu dữ liệu bền vững bằng MongoDB (khuyên dùng trên Render miễn phí)
Ổ đĩa của Render miễn phí bị xóa mỗi lần khởi động lại, nên hãy dùng MongoDB Atlas miễn phí (gói M0):
1. Tạo cluster M0 tại mongodb.com/atlas → Database Access: tạo user/mật khẩu → Network Access: thêm `0.0.0.0/0`.
2. Bấm Connect → Drivers → sao chép chuỗi kết nối dạng `mongodb+srv://user:matkhau@cluster0.xxxxx.mongodb.net/`.
3. Trên Render → Environment → thêm biến **`MONGODB_URI`** = chuỗi trên (và `ADMIN_PASSWORD`).
4. Deploy lại. Trang quản trị sẽ hiện "Lưu trữ: MongoDB (bền vững)".

Khi có `MONGODB_URI`, mọi dữ liệu (cấu hình các ô do admin lưu, các vòng/tuần, người chơi) nằm trong database `vongquay`
(collections `config`, `rounds`, `spins`; chỉ mục duy nhất roundId+phone đảm bảo mỗi SĐT chỉ quay 1 lần/vòng).
Không có `MONGODB_URI` → dùng file `data.json` như cũ.

Ô "Không trúng": tick ô này trong trang quản trị (hoặc đặt tên chứa "may mắn lần sau") để màn hình kết quả không hiện "Chúc mừng!".

## Đưa lên mạng miễn phí (để có link gửi Zalo)
**Render.com** (dễ nhất): đưa code lên GitHub → Render → New → Web Service → chọn repo → Build: `npm install`, Start: `npm start` → thêm biến môi trường `ADMIN_PASSWORD`. Bạn sẽ có link dạng `https://ten-app.onrender.com`.
⚠️ Gói miễn phí của Render: máy ngủ sau ~15 phút không dùng (lần mở đầu chậm ~30–50 giây) và **ổ đĩa không lưu lâu dài** – dữ liệu có thể mất khi khởi động lại/deploy lại. Hãy **tải CSV sau mỗi tuần**, hoặc gắn Persistent Disk (trả phí) và đặt `DATA_FILE=/var/data/data.json`.

**Railway.app**: New Project → Deploy from GitHub → thêm biến `ADMIN_PASSWORD`; thêm **Volume** gắn vào `/data` và đặt `DATA_FILE=/data/data.json` để giữ dữ liệu. (Có hạn mức dùng thử miễn phí.)

**Fly.io**: `fly launch`, tạo volume và đặt `DATA_FILE` vào volume đó.

**Máy tính/VPS riêng**: chạy `npm start` và dùng Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) để có link công khai miễn phí.

## Giới hạn
- Người chơi có thể dùng SĐT khác để quay thêm (không xác thực OTP). Shop nên đối chiếu SĐT khi trao quà.
- Lưu bằng file JSON: phù hợp vài nghìn lượt/tuần, chạy 1 máy chủ.
