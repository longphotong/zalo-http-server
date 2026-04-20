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

## Chạy server

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
