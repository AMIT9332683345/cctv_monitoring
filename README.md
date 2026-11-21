# OPPS CCTV

Private, single-owner CCTV for a CP Plus DVR on a home LAN.

- **Local gateway** (Windows PC, Node) talks to the DVR over RTSP/ONVIF, serves the dashboard on your Wi-Fi, runs FFmpeg for live HLS, snapshots, exports and an optional rolling buffer.
- **Cloud backend** (Render, Node) stores only metadata in MongoDB Atlas: owner account, gateway heartbeat, camera list, DVR capability cache, export jobs, settings and audit log. **No video is uploaded to the cloud.**
- **Frontend** (React + Vite + TypeScript) opens in gateway mode when the gateway is reachable and falls back to cloud mode for remote use.
- **Remote access** is designed for Tailscale/WireGuard. Nothing here port-forwards the DVR, RTSP, ONVIF or the gateway.

```
 Phone / laptop
   ├─ same Wi-Fi ─────────────► http://<PC-LAN-IP>:8089  (frontend + /gapi + streams)
   └─ Tailscale ──────────────► http://<tailnet-IP>:8089 (same gateway UI)
                                  │
                                  │ heartbeat / task poll (HTTPS)
                                  ▼
                            Render backend ──► MongoDB Atlas (metadata only)
                                  ▲
                                  │ HTTPS
                            Vercel frontend (cloud mode)
                                  │
                                  └── snapshot/clip media URLs signed for the gateway
```

Live video never transits the cloud. In cloud mode the Live page says so and links to the gateway URL; watch live on the LAN or through Tailscale.

## Contents

- [What is verified](#what-is-verified)
- [Requirements](#requirements)
- [Local setup (PowerShell)](#local-setup-powershell)
- [Cloud setup: Atlas + Render](#cloud-setup-atlas--render)
- [Frontend on Vercel](#frontend-on-vercel)
- [Remote access with Tailscale](#remote-access-with-tailscale)
- [Windows autostart](#windows-autostart)
- [Using the dashboard](#using-the-dashboard)
- [Tests](#tests)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Repository map](#repository-map)

## What is verified

Verified automatically on 2026-11-21 (Node 24.22.1, FFmpeg 9.1, Windows 10):

- `npm run test:backend` — **24 checks pass**: setup token, login, refresh rotation, CSRF header, security headers, CORS rejection, SSRF-free routing, gateway shared-secret auth, heartbeat/camera sync, command queue → task pull → result, job/snapshot validation, audit log, password change invalidation, logout revocation, login rate limiting.
- `npm run test:gateway` — **21 checks pass**: loopback-only setup, JWT/refresh rotation, DVR password never returned, private-IP SSRF guard, RTSP template injection guards, camera channel uniqueness, honest 504 when the DVR is unreachable, media-token camera/kind binding, path-traversal rejection, FFmpeg HLS self-test, **synthetic rolling-buffer export to MP4 with HTTP Range and download**, out-of-range buffer export failure, audit, password change, login rate limiting.
- Frontend type-check, production build, and a manual headless-Chrome pass (390×844 and 1440×900) over all seven pages, mobile drawer, modals, toasts, login/logout.

**NOT TESTED — requires the physical DVR, credentials and LAN access:**

- Live view, snapshots and audio from the real camera streams.
- ONVIF discovery/model/firmware/channel auto-detection.
- DVR playback export (the primary export source).
- Rolling-buffer capture from a real RTSP stream (the export pipeline itself is covered by a synthetic testsrc clip).
- Tailscale/WireGuard remote access, Render/Atlas/Vercel deployments, and Windows autostart on a reboot. Configuration files are provided; deployment steps are documented below.

The gateway never presents simulated footage as CCTV. The only synthetic video is inside the automated test suite, in a temporary data directory that is deleted afterwards.

## Requirements

- Windows 10/11 PC for the gateway. Node.js 20.11+ (24.x tested).
- FFmpeg and ffprobe on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`). `winget install Gyan.FFmpeg` then reopen the terminal.
- CP Plus DVR reachable on the LAN, with the RTSP/settings you actually have. Do not assume the username is `admin`, that RTSP is enabled, or that port 554 is in use — the setup wizard tests what is there.
- A phone/laptop on the same Wi-Fi for local viewing.
- Optional: MongoDB Atlas (free tier is enough), Render, Vercel, Tailscale. The gateway works fully locally without any of them if `BACKEND_URL` is empty.

## Local setup (PowerShell)

```powershell
cd C:\path\to\opps-cctv
npm install
npm run build
```

Create `gateway\.env` from the example and fill the secrets. Generate two independent secrets once:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```powershell
Copy-Item gateway\.env.example gateway\.env
notepad gateway\.env
```

Minimum for a local-only setup:

```ini
NODE_ENV=production
GATEWAY_PORT=8089
GATEWAY_HOST=0.0.0.0
GATEWAY_DATA_DIR=./data
STATIC_DIR=../frontend/dist
AUTH_SECRET=<48-byte base64url secret>
GATEWAY_SETUP_TOKEN=<32+ random characters>
BACKEND_URL=
GATEWAY_TOKEN=
FFMPEG_PATH=ffmpeg
```

Start it:

```powershell
npm run start:gateway
```

Open `http://localhost:8089` on the gateway PC and create the owner account (setup is allowed without a token only from `localhost`/loopback; from another machine it requires `GATEWAY_SETUP_TOKEN`). The password must be 12+ characters with letters and a number and must not contain your email name.

Then in **DVR Configuration**:

1. Enter the DVR IP, RTSP port, HTTP port and credentials. Choose the RTSP template that matches the DVR (CP Plus/Dahua is the default; Hikvision and generic are listed).
2. Save, then **Test connection**. The result shows TCP reachability, stream codec/resolution and ONVIF status separately — a partially working setup is reported honestly.
3. Scan channels to discover the real camera count. Add/label only the channels you use.

If the DVR test fails, the gateway reports the actual reason (timeout, disabled RTSP, bad template, auth failure). It does not fabricate a stream.

For LAN access, open `http://<PC-LAN-IP>:8089`. The frontend probes its own origin for `/gapi/health` first, so the same build runs locally and in the cloud.

## Cloud setup: Atlas + Render

Cloud mode is optional. It gives you a remote dashboard and job relay; the video remains on the gateway unless the browser fetches a signed media URL from the gateway.

### 1. MongoDB Atlas

1. Create a free M0 cluster and a database user.
2. Network Access: allow `0.0.0.0/0` (Render free instances do not have stable egress IPs). The database contains metadata only — no video and no DVR password (the DVR password is encrypted on the gateway PC only).
3. Copy the SRV connection string into `MONGODB_URI`.

### 2. Render

The repository contains `render.yaml` (Blueprint). In Render: **New → Blueprint**, pick this repo, and supply the secrets it asks for:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Atlas SRV string with the database user password |
| `AUTH_SECRET` | 48-byte base64url secret — **must match the gateway** |
| `SETUP_TOKEN` | one-time token for the first owner setup (24+ random chars) |
| `GATEWAY_TOKEN` | shared secret for heartbeat/task endpoints — **must match the gateway** |
| `CORS_ORIGINS` | your Vercel URL, e.g. `https://opps-cctv.vercel.app` |

`render.yaml` already sets `NODE_ENV=production`, `COOKIE_SECURE=true`, `COOKIE_SAMESITE=none`, `TRUST_PROXY=true`, `ALLOW_MEMORY_STORE=false` and health check `/healthz`.

Manual equivalent: root directory `.`, build `echo "backend has no build step"`, start `node backend/src/index.mjs`, health check `/healthz`.

Then:

1. Open `https://<service>.onrender.com/healthz` — expect `{"ok":true,"store":"mongo"...}`.
2. Create the cloud owner with `POST /api/setup` using `SETUP_TOKEN`, or open the Vercel frontend once it is deployed. Only one owner can exist; registration stays disabled afterwards.

Alternatively, create the owner from your PC against Atlas:

```powershell
cd backend
$env:OWNER_EMAIL='you@example.com'
$env:OWNER_PASSWORD='<12+ chars with letters and a number>'
$env:MONGODB_URI='<atlas srv string>'
$env:AUTH_SECRET='<same secret as Render>'
node scripts/bootstrap-owner.mjs
```

### 3. Point the gateway at the cloud

Edit `gateway\.env`:

```ini
BACKEND_URL=https://<service>.onrender.com
GATEWAY_TOKEN=<same value as the backend>
AUTH_SECRET=<same value as the backend>
GATEWAY_PUBLIC_URL=https://<how your phone can reach the gateway>   # e.g. Tailscale HTTPS URL
```

Restart the gateway. The Gateway Status page should show the cloud link connected after the first heartbeat (every 10 s). If it does not, the UI says offline — it never claims remote access that is not actually working.

`GATEWAY_PUBLIC_URL` is required for cloud-triggered snapshots and clip downloads, because the cloud returns media URLs that the browser must fetch from the gateway.

## Frontend on Vercel

Import the repo into Vercel. `vercel.json` at the repo root sets:

- install `npm install` (workspaces), build `npm run build`, output `frontend/dist`
- SPA rewrite to `index.html`
- security headers and long-lived caching for hashed assets

Set one environment variable in Vercel:

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | `https://<service>.onrender.com` (no trailing `/api`) |

Optional `VITE_GATEWAY_URL` (comma-separated) lets the page probe gateways before using the cloud. Note the browser rule: an **HTTPS** Vercel page cannot fetch an **HTTP** LAN gateway (mixed content). That probe only helps when the gateway is also served over HTTPS (for example Tailscale Serve). The reliable local path is opening the gateway's own URL on the LAN.

Redeploy after changing `VITE_*` variables. `CORS_ORIGINS` on the backend must contain the exact Vercel origin.

## Remote access with Tailscale

1. Install Tailscale on the Windows gateway PC and sign in (same tailnet as your phone/laptop).
2. Leave the gateway bound to `0.0.0.0:8089` and open `http://<tailnet-IP>:8089` from the remote device.
3. For HTTPS, use Tailscale Serve, or provide `TLS_CERT`/`TLS_KEY` in `gateway\.env` and set `COOKIE_SECURE=true`.
4. Do **not** forward ports 554, 80, 8089 or the DVR on the router.

Remote access has not been exercised in this environment. Do not treat it as working until the tailnet connection and the gateway heartbeat both show connected.

## Windows autostart

From an **elevated** PowerShell:

```powershell
cd C:\path\to\opps-cctv\gateway
powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
Start-ScheduledTask -TaskName OppsCctvGateway
```

This registers a logon scheduled task that runs `scripts\start-gateway.ps1` hidden, restarts up to 3 times, and adds an inbound firewall rule for TCP 8089 **on the Private profile only**. To remove it:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-autostart.ps1
```

## Using the dashboard

Seven pages, mobile-first:

- **Dashboard** — camera grid, live previews, gateway/DVR/storage/buffer health, per-camera snapshot, refresh.
- **Live Cameras** — one camera at a time, fullscreen, live indicator, load/reconnect state, mute when the stream has audio.
- **Clip Export** — camera, date, start/end or duration (15 min default), source `auto` / DVR / buffer, progress, play, MP4 download, delete.
- **Export History** — past jobs with their real source label (`DVR playback` or `Local buffer`), size, duration and errors.
- **Gateway Status** — heartbeat, cloud link, DVR capability cache, storage figures, buffer controls and retention.
- **DVR Configuration** — discovery (WS-Discovery), manual entry fallback, connection test, channel scan, per-camera settings.
- **Security Settings** — password change, optional TOTP (cloud mode), sessions, audit log, sign out.

Exports try DVR playback first when the camera allows it and fall back to the rolling buffer. When neither source covers the requested time, the job fails with both reasons spelled out; it never labels a failed/empty file as success. The rolling buffer is a separate experimental recording of the live RTSP stream — it is not the DVR's own archive, and old footage the buffer never captured cannot be recovered from a live-only stream.

## Tests

```powershell
npm run test:backend
npm run test:gateway
npm test                 # both
npm run typecheck
npm run build
```

Both suites are self-contained: they spawn their own service on a free port with a temporary data directory and clean up afterwards. They do not touch a running gateway, your `.env`, or your DVR. The gateway suite needs `ffmpeg` on `PATH` for the HLS self-test and synthetic export; without it those checks are reported as skipped.

Hardware-dependent checks are deliberately not automated here; see [What is verified](#what-is-verified).

## Security notes

- **Network**: DVR and gateway are never port-forwarded. The gateway firewall rule is Private-profile only. Remote access is expected over Tailscale/WireGuard.
- **DVR credentials**: never sent to the browser or cloud. They are encrypted at rest with AES-256-GCM using `gateway/data/master.key` (or `GATEWAY_KEY`). Back up `master.key` with `state.json`; losing it means re-entering the DVR password. No default credentials are shipped.
- **SSRF**: DVR hosts must be literal private IPs (RFC1918, loopback, CGNAT/Tailscale) or hostnames resolving to them, unless `ALLOW_PUBLIC_DVR_HOSTS=true`. RTSP templates must start with `/` and contain no whitespace, so a template cannot override the host or inject arguments.
- **Auth**: scrypt password hashes; HS256 access tokens (15 min); rotating, hashed refresh tokens in HttpOnly cookies (`SameSite=Lax` locally, `None; Secure` in production); `X-Opps-Client: web` CSRF header on cookie-auth endpoints; `tokenVersion` invalidation on password change; rate-limited setup/login/refresh/exports; login failures and every sensitive action audited.
- **Media tokens**: short-lived, audience `media`, bound to a camera (`live`/`snapshot`) or job (`clip`) and to the token kind, so a link cannot be reused for another camera, another clip, or a filesystem path.
- **Files**: clips are reached by job id through `safeFilePath`; traversal attempts return 404. Clip serving supports `Range` and download disposition names derived from sanitized camera names.
- **Headers**: `nosniff`, `DENY` framing, no-referrer, restrictive CSP (including `worker-src blob:` for hls.js), permissions policy, HSTS in production, `no-store` on API responses.
- **Logs**: DVR passwords and tokens are redacted; request logs exclude query strings (media tokens) and use request ids.
- **Cloud data**: MongoDB stores metadata only. Video stays in `gateway/data` (or `GATEWAY_DATA_DIR`) and is deleted by clip retention (default 7 days, hourly cleanup) or manually.

Rotate `AUTH_SECRET` on both sides to sign out every session and invalidate outstanding media links. Rotating `GATEWAY_TOKEN` requires updating both the backend and the gateway.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Phone cannot open the gateway page | Same Wi-Fi? Private-profile firewall rule? `GATEWAY_HOST=0.0.0.0`? Try `http://<PC-LAN-IP>:8089` on the PC first. |
| Gateway status shows DVR unreachable | DVR IP, RTSP enabled, port, credentials, RTSP template. The test result distinguishes TCP failure from stream/auth failure. |
| Live view times out (504) | The gateway refuses to fake a stream when FFmpeg cannot open RTSP. Check DVR logs, stream subtype, encoder (`HLS_ENCODER=copy` needs H.264). |
| Export failed | Read the job error: it lists the DVR playback reason and the buffer reason separately. Out-of-window buffer ranges fail; enable the buffer and wait for coverage. |
| Cloud link offline | `BACKEND_URL`, `GATEWAY_TOKEN`, Render is awake, gateway can reach the internet. Heartbeat window is 45 s. |
| Cloud login loops / 401 refresh | Production needs `COOKIE_SECURE=true` and `COOKIE_SAMESITE=none`; `CORS_ORIGINS` must exactly match the Vercel origin; `TRUST_PROXY=true` behind Render. |
| `ffmpeg not found` | Install FFmpeg, reopen the shell, or set an absolute `FFMPEG_PATH`/`FFPROBE_PATH`. |
| Too many login attempts | Rate limit is 10 per 15 minutes per IP and per email (gateway and backend). Wait for `Retry-After`. |
| Buffer fills the disk | Lower `bufferRetentionMinutes` or `bufferDiskCapGb` in Settings; the gateway enforces both during its periodic cleanup. |

## Repository map

```
backend/            Zero-dependency cloud API (Node HTTP)
  src/              app, auth, Mongo/memory store, security, logging
  scripts/          bootstrap-owner.mjs
  .env.example
gateway/            Windows-local gateway
  src/              API, auth, DVR adapters, FFmpeg, HLS, buffer, jobs, sync
  scripts/          start-gateway.ps1, install/uninstall-autostart.ps1
  .env.example
frontend/           React + Vite + TypeScript dashboard
  src/              pages, state, API client, player, styles
scripts/            smoke-backend.mjs, smoke-gateway.mjs
render.yaml         Render blueprint for the backend
vercel.json         Vercel build, SPA rewrite, headers
```

Environment variables are documented inline in each `.env.example`; no real secrets are committed.
