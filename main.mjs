#!/usr/bin/env node
/**
 * zalo-server: HTTP server bọc zca-js — không có độ trễ khởi động.
 *
 * Yêu cầu plugin zalouser của OpenClaw đã đăng nhập sẵn.
 * Đọc thông tin xác thực từ ~/.openclaw/credentials/zalouser/credentials.json
 * và tái sử dụng phiên hiện có — KHÔNG tự đăng nhập lại khi gặp lỗi.
 *
 * Cách dùng:
 *   node main.mjs [--port 3099] [--profile default] [--host 127.0.0.1]
 *
 * Endpoints:
 *   POST /send       — gửi tin nhắn văn bản (+ file đính kèm tuỳ chọn)
 *   POST /send-file  — gửi file/ảnh
 *   GET  /health     — kiểm tra trạng thái server
 *   GET  /me         — thông tin tài khoản đang đăng nhập
 *
 * Request body (JSON):
 *   { "to": "<userId|groupId>", "message": "nội dung", "group": false }
 *
 * Gửi kèm file:
 *   { "to": "...", "message": "chú thích", "files": ["đường_dẫn_hoặc_url", ...], "group": false }
 *
 * Phản hồi lỗi:
 *   { "ok": false, "error": "<thông báo>", "code": "<SESSION_EXPIRED|SEND_FAILED|...>" }
 *
 * Exit codes: 0 = tắt bình thường, 1 = lỗi nghiêm trọng
 */

import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { createServer } from "http";
import os from "os";

// ─── Tải .env (nếu có) ───────────────────────────────────────────────────────

const ENV_PATH = join(new URL(".", import.meta.url).pathname, ".env");
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const eq = clean.indexOf("=");
    if (eq === -1) continue;
    const key = clean.slice(0, eq).trim();
    const val = clean.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
  console.log(`[init] Đã tải cấu hình từ .env`);
}

// ─── Cấu hình ────────────────────────────────────────────────────────────────

const PORT             = parseInt(process.env.PORT                 ?? parseArg("--port",    "3099"));
const HOST             =           process.env.HOST                 ?? parseArg("--host",    "127.0.0.1");
const PROFILE          =           process.env.ZALO_PROFILE         ?? parseArg("--profile", "default");
const CREDENTIALS_DIR  =           process.env.OPENCLAW_CREDENTIALS_DIR
                                   ?? join(os.homedir(), ".openclaw/credentials/zalouser");
const REQUEST_TIMEOUT_MS = 20_000;

function parseArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

// ─── Tải zca-js ──────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);

function resolveZcaJs() {
  const candidates = [
    process.env.ZCA_JS_PATH,
    join(os.homedir(), ".npm-global/lib/node_modules/openclaw/node_modules/zca-js"),
    join(os.homedir(), ".nvm/versions/node", process.version, "lib/node_modules/openclaw/extensions/zalouser/node_modules/zca-js"),
    process.env.OPENCLAW_EXTENSIONS_DIR && join(process.env.OPENCLAW_EXTENSIONS_DIR, "zalouser/node_modules/zca-js"),
    join(process.cwd(), "node_modules/zca-js"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  const nodeDir = process.execPath.replace(/\/bin\/node$/, "");
  const fallback = join(nodeDir, "lib/node_modules/openclaw/extensions/zalouser/node_modules/zca-js");
  if (existsSync(fallback)) return fallback;

  throw new Error(
    "Không tìm thấy zca-js. Hãy đặt biến môi trường ZCA_JS_PATH:\n" +
    "  ZCA_JS_PATH=/đường/dẫn/zca-js node main.mjs"
  );
}

const ZCA_PATH = resolveZcaJs();
const { Zalo, ThreadType } = require(ZCA_PATH);
console.log(`[init] Đã tải zca-js từ: ${ZCA_PATH}`);

// ─── Thông tin xác thực ──────────────────────────────────────────────────────

function resolveCredentialsPath(profile) {
  const name =
    !profile || profile === "default"
      ? "credentials.json"
      : `credentials-${encodeURIComponent(profile.trim().toLowerCase())}.json`;
  return join(CREDENTIALS_DIR, name);
}

function loadCredentials(profile) {
  const path = resolveCredentialsPath(profile);
  if (!existsSync(path)) {
    throw new Error(
      `Không tìm thấy thông tin xác thực Zalo tại ${path}.\n` +
      `Hãy đảm bảo OpenClaw zalouser đã đăng nhập: openclaw channels login --channel zalouser`
    );
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ─── Xử lý file ──────────────────────────────────────────────────────────────

async function loadFile(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${source}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = basename(new URL(source).pathname) || "file.bin";
    return { buf, name };
  }
  if (!existsSync(source)) throw new Error(`Không tìm thấy file: ${source}`);
  const buf = readFileSync(source);
  return { buf, name: basename(source) };
}

function buildAttachment(buf, name) {
  const safeName = name.includes(".") ? name : `${name}${extname(name) || ".bin"}`;
  return { data: buf, filename: safeName, metadata: { totalSize: buf.length } };
}

// ─── Mã lỗi ──────────────────────────────────────────────────────────────────

function classifyError(err) {
  const msg = err.message ?? "";
  if (/cookie|session|expired|unauthorized|login|auth/i.test(msg))
    return { code: "SESSION_EXPIRED", hint: "Đăng nhập lại: openclaw channels login --channel zalouser" };
  if (/timeout/i.test(msg))
    return { code: "TIMEOUT", hint: "Zalo API không phản hồi kịp thời" };
  if (/not found|invalid.*id/i.test(msg))
    return { code: "INVALID_TARGET", hint: "Kiểm tra lại ID người dùng/nhóm" };
  if (/file not found/i.test(msg))
    return { code: "FILE_NOT_FOUND", hint: msg };
  return { code: "SEND_FAILED", hint: null };
}

// ─── ZaloApi — wrapper mỏng, không có logic kết nối lại ──────────────────────

class ZaloApi {
  constructor(profile) {
    this.profile = profile;
    this.api     = null;
  }

  async init() {
    const creds = loadCredentials(this.profile);
    const zalo  = new Zalo({ logging: false, selfListen: false });
    this.api    = await zalo.login({
      imei:      creds.imei,
      cookie:    creds.cookie,
      userAgent: creds.userAgent,
      language:  creds.language,
    });
    console.log(`[session] ✅ Sẵn sàng (profile: ${this.profile})`);
  }

  async sendTypingEvent(to, group = false) {
    if (!this.api) throw new Error("SESSION_EXPIRED");
    const threadType = group ? ThreadType.Group : ThreadType.User;
    return this.api.sendTypingEvent(to, threadType);
  }

  async sendMessage(to, msg, files = [], group = false) {
    if (!this.api) throw new Error("SESSION_EXPIRED");

    const threadType = group ? ThreadType.Group : ThreadType.User;

    if (files.length === 0) {
      return this.api.sendMessage({ msg }, to, threadType);
    }

    console.log(`[session] Đang tải ${files.length} file...`);
    const attachments = await Promise.all(
      files.map(async (src) => {
        const { buf, name } = await loadFile(src);
        console.log(`  + ${name} (${buf.length} bytes)`);
        return buildAttachment(buf, name);
      })
    );
    return this.api.sendMessage({ msg, attachments }, to, threadType);
  }

  async fetchAccountInfo() {
    if (!this.api) throw new Error("SESSION_EXPIRED");
    return this.api.fetchAccountInfo();
  }
}

// ─── Tiện ích HTTP ────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setTimeout(REQUEST_TIMEOUT_MS, () => reject(new Error("Hết thời gian chờ request")));
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(new Error("Body JSON không hợp lệ")); }
    });
    req.on("error", reject);
  });
}

function reply(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Hết thời gian chờ sau ${ms}ms`)), ms)
    ),
  ]);
}

function errorResponse(res, err) {
  const { code, hint } = classifyError(err);
  const isSessionErr   = code === "SESSION_EXPIRED";
  console.error(`[error] ${code}: ${err.message}`);
  return reply(res, isSessionErr ? 401 : 500, {
    ok: false,
    error: err.message,
    code,
    ...(hint ? { hint } : {}),
  });
}

// ─── Send lock — serializes /send, /send-file, /send-batch ───────────────────

let _sendQueue = Promise.resolve();
let _sendQueueDepth = 0;

function withSendLock(label, fn) {
  _sendQueueDepth++;
  const pos = _sendQueueDepth;
  if (pos > 1) console.log(`[lock] ⏳ ${label} xếp hàng chờ (vị trí ${pos})`);
  const slot = _sendQueue.then(async () => {
    if (pos > 1) console.log(`[lock] ▶ ${label} bắt đầu chạy`);
    try { return await fn(); }
    finally { _sendQueueDepth--; }
  });
  _sendQueue = slot.catch(() => {});
  return slot;
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function router(req, res, zalo) {
  const { method, url } = req;
  console.log(`[http] ${method} ${url}`);

  // GET /health
  if (method === "GET" && url === "/health") {
    return reply(res, 200, { ok: true, profile: zalo.profile });
  }

  // GET /me
  if (method === "GET" && url === "/me") {
    try {
      const info = await withTimeout(zalo.fetchAccountInfo());
      return reply(res, 200, { ok: true, data: info });
    } catch (err) {
      return errorResponse(res, err);
    }
  }

  // POST /send
  if (method === "POST" && url === "/send") {
    let body;
    try { body = await readBody(req); }
    catch (err) { return reply(res, 400, { ok: false, error: err.message, code: "BAD_REQUEST" }); }

    const { to, message = "", group = false } = body;
    if (!to) return reply(res, 400, { ok: false, error: 'Thiếu trường "to"', code: "BAD_REQUEST" });

    return withSendLock("/send", async () => {
      try {
        await zalo.sendTypingEvent(to, group).catch(() => {});
        await new Promise((r) => setTimeout(r, 1000));
        const result = await withTimeout(zalo.sendMessage(to, message, [], group));
        const msgId  = result?.message?.msgId ?? result?.msgId ?? "?";
        console.log(`[send] ✅ msgId=${msgId} → ${to}`);
        reply(res, 200, { ok: true, msgId, result });
      } catch (err) {
        errorResponse(res, err);
      }
    });
  }

  // POST /send-batch
  if (method === "POST" && url === "/send-batch") {
    let body;
    try { body = await readBody(req); }
    catch (err) { return reply(res, 400, { ok: false, error: err.message, code: "BAD_REQUEST" }); }

    const { targets, message = "", delay = 1000 } = body;
    if (!Array.isArray(targets) || targets.length === 0)
      return reply(res, 400, { ok: false, error: 'Thiếu trường "targets" (mảng)', code: "BAD_REQUEST" });
    if (!message)
      return reply(res, 400, { ok: false, error: 'Thiếu trường "message"', code: "BAD_REQUEST" });

    return withSendLock("/send-batch", async () => {
      const results = [];
      for (let i = 0; i < targets.length; i++) {
        const entry = targets[i];
        const to    = typeof entry === "string" ? entry : entry.to;
        const group = typeof entry === "object" ? (entry.group ?? false) : false;

        if (!to) {
          results.push({ to, ok: false, error: "Thiếu trường to", code: "BAD_REQUEST" });
          continue;
        }

        try {
          await zalo.sendTypingEvent(to, group).catch(() => {});
          await new Promise((r) => setTimeout(r, 1000));
          const result = await withTimeout(zalo.sendMessage(to, message, [], group));
          const msgId  = result?.message?.msgId ?? result?.msgId ?? "?";
          console.log(`[send-batch] ✅ msgId=${msgId} → ${to} (${i + 1}/${targets.length})`);
          results.push({ to, ok: true, msgId });
        } catch (err) {
          const { code, hint } = classifyError(err);
          console.error(`[send-batch] ❌ ${code}: ${err.message} → ${to}`);
          results.push({ to, ok: false, error: err.message, code, ...(hint ? { hint } : {}) });
          if (code === "SESSION_EXPIRED") break;
        }

        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, delay));
      }

      const allOk = results.every((r) => r.ok);
      reply(res, 200, { ok: allOk, sent: results.filter((r) => r.ok).length, total: targets.length, results });
    });
  }

  // POST /send-file
  if (method === "POST" && url === "/send-file") {
    let body;
    try { body = await readBody(req); }
    catch (err) { return reply(res, 400, { ok: false, error: err.message, code: "BAD_REQUEST" }); }

    const { to, message = "", files = [], group = false } = body;
    if (!to)           return reply(res, 400, { ok: false, error: '"to" is required',    code: "BAD_REQUEST" });
    if (!files.length) return reply(res, 400, { ok: false, error: 'Thiếu trường "files"', code: "BAD_REQUEST" });

    return withSendLock("/send-file", async () => {
      try {
        await zalo.sendTypingEvent(to, group).catch(() => {});
        await new Promise((r) => setTimeout(r, 1000));
        const result      = await withTimeout(zalo.sendMessage(to, message, files, group));
        const msgId       = result?.message?.msgId ?? result?.msgId ?? "?";
        const attachCount = result?.attachment?.length ?? 0;
        console.log(`[send-file] ✅ msgId=${msgId}, attachments=${attachCount} → ${to}`);
        reply(res, 200, { ok: true, msgId, attachments: attachCount, result });
      } catch (err) {
        errorResponse(res, err);
      }
    });
  }

  return reply(res, 404, { ok: false, error: "Không tìm thấy", code: "NOT_FOUND" });
}

// ─── Khởi động ───────────────────────────────────────────────────────────────

async function main() {
  const zalo = new ZaloApi(PROFILE);

  console.log(`[init] Đang kết nối đến phiên OpenClaw hiện có (profile: ${PROFILE})...`);
  await zalo.init(); // fails fast if credentials missing or session invalid

  const server = createServer((req, res) => {
    router(req, res, zalo).catch((err) => {
      console.error("[http] Lỗi không xử lý được:", err);
      if (!res.headersSent) reply(res, 500, { ok: false, error: "Lỗi máy chủ nội bộ", code: "INTERNAL" });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[http] 🚀 Zalo HTTP server đang chạy tại http://${HOST}:${PORT}`);
    console.log(`[http] Endpoints: GET /health  GET /me  POST /send  POST /send-file  POST /send-batch`);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`\n[shutdown] Nhận tín hiệu ${sig}, đang đóng...`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error("[fatal]", err.message);
  process.exit(1);
});
