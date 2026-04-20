# zalo-server

HTTP server bọc `zca-js` để gửi tin nhắn Zalo qua API cục bộ — không có độ trễ khởi động nhờ giữ phiên luôn sẵn sàng.

**Yêu cầu:** Plugin `zalouser` của OpenClaw phải đã đăng nhập trước. Server tái sử dụng phiên hiện có, không tự đăng nhập lại.

## Cài đặt

Không cần cài thêm dependency. Chỉ cần Node.js và OpenClaw đã cài sẵn.

Sao chép và chỉnh file cấu hình:

```bash
cp .env.example .env
```

Server tự động tải `.env` khi khởi động — không cần cờ hay wrapper thêm.

## Chạy như systemd service

Service chạy ở user-level (không cần `sudo`), chỉ lắng nghe `127.0.0.1` — không mở ra ngoài.

```bash
# Cài service (chạy một lần)
cp ~/.config/systemd/user/zalo-server.service  # đã có sẵn trong repo
systemctl --user daemon-reload
systemctl --user enable zalo-server
systemctl --user start zalo-server
```

Các lệnh thường dùng:

```bash
systemctl --user status zalo-server   # kiểm tra trạng thái
systemctl --user restart zalo-server  # khởi động lại
systemctl --user stop zalo-server     # dừng
journalctl --user -u zalo-server -f   # xem log realtime
```

## Chạy thủ công

```bash
node main.mjs
```

Hoặc truyền tham số trực tiếp (ưu tiên cao hơn `.env`):

```bash
node main.mjs --port 3099 --profile default --host 127.0.0.1
```

## Endpoints

### `GET /health`
Kiểm tra trạng thái server.

```bash
curl http://localhost:3099/health
```

### `GET /me`
Thông tin tài khoản Zalo đang đăng nhập.

```bash
curl http://localhost:3099/me
```

### `POST /send`
Gửi tin nhắn văn bản.

```bash
curl -s -X POST http://localhost:3099/send \
  -H "Content-Type: application/json" \
  -d '{"to":"USER_ID","message":"Xin chào!"}'
```

Gửi vào nhóm (bắt buộc có `"group": true`):

```bash
curl -s -X POST http://localhost:3099/send \
  -H "Content-Type: application/json" \
  -d '{"to":"GROUP_ID","message":"Xin chào nhóm!","group":true}'
```

### `POST /send-file`
Gửi file hoặc ảnh (đường dẫn cục bộ hoặc URL).

```bash
curl -s -X POST http://localhost:3099/send-file \
  -H "Content-Type: application/json" \
  -d '{"to":"USER_ID","message":"Chú thích","files":["/path/to/image.png"]}'
```

### `POST /send-batch`
Gửi cùng một tin nhắn tới nhiều user/group tuần tự. Mỗi tin cách nhau 3000ms (tuỳ chỉnh được). Khi endpoint này đang chạy, các endpoint gửi tin khác (`/send`, `/send-file`) sẽ xếp hàng chờ.

```bash
# Gửi tới nhiều user
curl -s -X POST http://localhost:3099/send-batch \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Xin chào!",
    "targets": ["USER_ID_1", "USER_ID_2", "USER_ID_3"]
  }'

# Gửi tới nhiều nhóm
curl -s -X POST http://localhost:3099/send-batch \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Thông báo!",
    "targets": [
      {"to": "GROUP_ID_1", "group": true},
      {"to": "GROUP_ID_2", "group": true}
    ]
  }'

# Mix user + group, delay tuỳ chỉnh (ms)
curl -s -X POST http://localhost:3099/send-batch \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello!",
    "delay": 5000,
    "targets": [
      "USER_ID_1",
      {"to": "GROUP_ID_1", "group": true}
    ]
  }'
```

Phản hồi:
```json
{
  "ok": true,
  "sent": 3,
  "total": 3,
  "results": [
    { "to": "USER_ID_1", "ok": true, "msgId": "..." },
    { "to": "USER_ID_2", "ok": true, "msgId": "..." },
    { "to": "GROUP_ID_1", "ok": true, "msgId": "..." }
  ]
}
```

> Nếu gặp `SESSION_EXPIRED` ở bất kỳ tin nào, vòng lặp dừng ngay lập tức.

## Định dạng phản hồi

Thành công:
```json
{ "ok": true, "msgId": "...", "result": { ... } }
```

Lỗi:
```json
{ "ok": false, "error": "...", "code": "SESSION_EXPIRED", "hint": "..." }
```

| Mã lỗi | HTTP | Ý nghĩa |
|---|---|---|
| `SESSION_EXPIRED` | 401 | Phiên hết hạn, cần đăng nhập lại |
| `TIMEOUT` | 500 | Zalo API không phản hồi kịp (20s) |
| `INVALID_TARGET` | 500 | ID người dùng/nhóm không hợp lệ |
| `FILE_NOT_FOUND` | 500 | Không tìm thấy file đính kèm |
| `SEND_FAILED` | 500 | Lỗi gửi khác |
| `BAD_REQUEST` | 400 | Thiếu hoặc sai tham số |

## Đăng nhập lại khi phiên hết hạn

```bash
openclaw channels login --channel zalouser
```
