# DSH Weak Network Tuning

[![npm](https://img.shields.io/npm/v/dsh-weaknet.svg)](https://www.npmjs.com/package/dsh-weaknet)

> 中文摘要：握手 15s→60s、Gateway 心跳 2s→15s、WebSocket permessage-deflate、HTTP Brotli 优先、keep-alive 5s→30s。安装：`dsh plugin --profile web add dsh-weaknet`。

Keeps the Harness Web UI usable on high-latency or lossy links. Three layers,
each idempotent and independently observable.

## What it changes

| Layer | Where | Effect |
| --- | --- | --- |
| Recovery override | `__DSH_CONNECTION_RECOVERY__` in every index response | Handshake deadline 15 s → **60 s**, slow-handshake warning 3 s → 20 s, backoff base 500 → 800 ms, factor 2 → 1.7, cap 10 s → 15 s. Applies on page reload. |
| Gateway patch (`dsh-weaknet-gateway-patch`) | `dsh-api-gateway/lib/index.js` | WebSocket heartbeat **2 s → 15 s** (the shipped server terminates a socket after two missed pongs, i.e. ~6 s — a single RTT spike kills the session) and enables **`permessage-deflate`** on the multiplexed API socket. |
| Brotli + keep-alive patch (`dsh-weaknet-brotli-patch`) | `dsh-host-webserver/lib/index.js` | Negotiates **`br` before `gzip`** for HTTP responses and raises the HTTP keep-alive idle timeout from 5 s to **30 s**, so an active tab reuses TCP/TLS connections instead of re-handshaking after every short pause. The `compression` middleware already supports Brotli; the shipped wrapper rewrote `accept-encoding` to `gzip` only, so Brotli never reached it. |

The Gateway and WebServer modules are read at import time, so their patches
take effect on the **next Harness start**. The recovery override is injected
into each index response and takes effect on the next page load. Running
`node apply.mjs` before `dsh web` makes one restart enough after an upgrade.

## Why the heartbeat matters most

`RemoteStreamMuxServer` pings every `websocketHeartbeatIntervalMs` and
terminates a socket once two heartbeats are missed. With the shipped 2 s
interval, a pong delayed by roughly 6 s closes the socket, the generation loop
retries, and on a high-RTT link the page can cycle through reconnect and
handshake timeouts without ever settling. 15 s keeps ~30–45 s of tolerance
while still detecting a dead peer.

## Compression

- HTTP: Brotli for `text/*`, JavaScript, CSS, JSON and SVG; gzip remains the
  fallback. `text/event-stream` is excluded by the shipped filter. Idle
  keep-alive connections live 30 s instead of 5 s.
- WebSocket: `permessage-deflate` with a 1 KiB threshold and zlib level 3.
  Browsers that offer the extension (Chromium, Firefox, Safari) negotiate it
  automatically; no client change is needed.

## Idempotency

Each file patch prepends its marker comment and skips when the marker is
present. A `dsh` upgrade replaces the build and drops the marker, so the next
boot (or `node apply.mjs`) re-applies it. Both patches are syntax-checked with
`node --check` before they replace a file.

## Installation

```sh
dsh plugin --profile web add dsh-weaknet
```

or install the directory through Plugin Manager. The recovery override is
active immediately; restart once to load the transport patches.

For an npm-installed package, the pre-boot helper lives in the profile:

```sh
node ~/.dsh/profiles/web/node_modules/dsh-weaknet/apply.mjs
```

## Tuning

Edit `RECOVERY` / `HEARTBEAT_INTERVAL_MS` in `lib/patches.js`. After changing a
value, delete the two markers from the built files (or reinstall `dsh`) so the
transform runs again.
