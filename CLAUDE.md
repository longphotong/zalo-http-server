# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file HTTP server (`main.mjs`) that wraps `zca-js` (the Zalo client library bundled with OpenClaw) and exposes a local JSON API for sending Zalo messages — eliminating cold-start latency by keeping the session warm.

**Prerequisite:** OpenClaw zalouser plugin must already be logged in. This server reuses an existing session and does NOT attempt re-login.

## Running

```bash
node main.mjs --port 3099 --profile default
```

Config can also be passed via env vars: `PORT`, `HOST`, `ZALO_PROFILE`.

Override the zca-js path: `ZCA_JS_PATH=/path/to/zca-js node main.mjs`  
Override the OpenClaw extensions directory: `OPENCLAW_EXTENSIONS_DIR=/path/to/extensions node main.mjs`

**Startup behavior:** `zalo.init()` runs at boot and fails fast — if credentials are missing or the session is already expired, the process exits with code `1` before the HTTP server starts.

## Endpoints

```bash
# Health check
curl http://localhost:3099/health

# Account info
curl http://localhost:3099/me

# Send text message
curl -s -X POST http://localhost:3099/send \
  -H "Content-Type: application/json" \
  -d '{"to":"USER_OR_GROUP_ID","message":"Hello!"}'

# Send to group (requires "group": true)
curl -s -X POST http://localhost:3099/send \
  -H "Content-Type: application/json" \
  -d '{"to":"GROUP_ID","message":"Hello nhóm!","group":true}'

# Send file or image (local path or URL)
curl -s -X POST http://localhost:3099/send-file \
  -H "Content-Type: application/json" \
  -d '{"to":"USER_ID","message":"Caption","files":["/path/to/img.png"]}'
```

## Architecture

Everything lives in one file — no build step, no dependencies to install.

Key design decisions:
- **`zca-js` is loaded at runtime** via `resolveZcaJs()`, which walks several candidate paths to find the copy bundled inside the OpenClaw extension. Override with `ZCA_JS_PATH` env var.
- **Credentials** are read from `~/.openclaw/credentials/zalouser/credentials.json` (or `credentials-{profile}.json` for non-default profiles). Fields used: `imei`, `cookie`, `userAgent`, `language`.
- **`ZaloApi`** is a thin wrapper around the zca-js `api` object. It holds a single session and has no reconnect logic — if the session expires, endpoints return `401` with code `SESSION_EXPIRED`.
- **Error codes** are classified by `classifyError()`: `SESSION_EXPIRED`, `TIMEOUT`, `INVALID_TARGET`, `FILE_NOT_FOUND`, `SEND_FAILED`.
- **Timeout** for all Zalo API calls is `REQUEST_TIMEOUT_MS = 20_000ms`, enforced with a `Promise.race`.
- **Files** sent via `/send-file` can be local paths or HTTP(S) URLs — both are loaded into memory before sending.

## Response shapes

Success:
```json
{ "ok": true, "msgId": "...", "result": { ... } }
```

Error:
```json
{ "ok": false, "error": "message", "code": "SESSION_EXPIRED|TIMEOUT|INVALID_TARGET|FILE_NOT_FOUND|SEND_FAILED|BAD_REQUEST", "hint": "optional" }
```

HTTP status is `200` on success, `400` for bad input, `401` for `SESSION_EXPIRED`, `500` for all others.

## Credentials path

Default profile: `~/.openclaw/credentials/zalouser/credentials.json`  
Named profile `foo`: `~/.openclaw/credentials/zalouser/credentials-foo.json`

To re-login if session expires:
```bash
openclaw channels login --channel zalouser
```
