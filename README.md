# PodSync Web (alpha)

A pure HTML5/CSS/JS port of the desktop PodSync app. Same backend
(`podsync-eeriecast.duckdns.org` on Hetzner), same relay protocol,
same library endpoints — just running in the browser instead of
PyInstaller + pywebview + PortAudio.

## Why

The desktop build occasionally freezes on startup on certain machines
(WebView2 / pythonnet init issues). The webapp has no such dependency
stack — open the page and you're done. This is a parallel experiment
alongside the desktop build, nothing here changes `main_web.py`,
`recorder.py`, or any of the existing code.

## What works in this build

- Signup / login / logout (hits the existing `/library/*` endpoints)
- Home screen + full navigation
- **Host**: create room, record, sync tone, stop, auto-upload
- **Guest**: join room, record, stop, auto-upload
- Sessions library (list, download, delete)
- Test audio screen (record 10s, play back)
- Settings (display name, email, default mic, change password)
- Participant chips with live mic-level glow (same as desktop)
- Auto-download of each recording as a local safety-net copy when you stop

## Audio quality

Same quality path as the desktop:

- `getUserMedia` with **echoCancellation / noiseSuppression / autoGainControl
  all disabled** (critical — default constraints apply Chrome's cellphone DSP)
- `AudioWorkletNode` (not `MediaRecorder`) taps the raw Float32 audio stream
- 48 kHz mono, converted to 16-bit signed PCM at stop()
- Output WAV header is byte-identical to what the Python `Recorder`
  produces

## Run locally

getUserMedia requires a secure context. The browser accepts `localhost`
as secure, so HTTPS is NOT needed for local testing.

```powershell
# From the repo root:
py webapp\serve.py

# Then open http://localhost:8080/ — the script auto-opens your browser.
```

You can also use any static server if you prefer (`python -m http.server 8080`
inside `webapp/`, or `npx serve`). The only thing that matters is the
files are served over `http://localhost` or `https://`.

## Run it properly on Hetzner

The webapp is pure static files. Any web server that can serve
HTML/JS/CSS over HTTPS will work:

1. Copy the `webapp/` folder onto the Hetzner box, e.g.
   `/var/www/podsync-web/`.
2. Point your existing nginx/Caddy at it. Minimal nginx snippet:

   ```nginx
   server {
     listen 443 ssl;
     server_name podsync.eeriecast.com;
     root /var/www/podsync-web;
     index index.html;

     # js modules must be served with a JS mime type
     types { application/javascript js; }

     # Set the same COOP/COEP headers the dev server uses if you
     # later want to add OPFS-based durable recording.
     add_header Cross-Origin-Opener-Policy "same-origin";
     add_header Cross-Origin-Embedder-Policy "require-corp";
   }
   ```

3. That's it. The webapp hits `wss://podsync-eeriecast.duckdns.org/ws`
   (defined in `js/relay.js`) and `https://podsync-eeriecast.duckdns.org`
   (in `js/library.js`) for all backend work — same URLs the desktop
   app already uses.

## CORS note

If your Hetzner relay is hosted under a different domain than the
webapp (e.g. `podsync.eeriecast.com` serving the UI, relay at
`podsync-eeriecast.duckdns.org`), the relay must respond with:

```
Access-Control-Allow-Origin: https://podsync.eeriecast.com
Access-Control-Allow-Headers: X-Library-Password, X-Session-Room, X-Session-Pin, Content-Type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

and handle `OPTIONS` preflights with a 204.

If everything lives on the same origin (serve `webapp/` from the same
nginx config that proxies the relay), no CORS changes are needed.

## File layout

```
webapp/
├─ index.html         all screens in one file (shares the desktop's CSS)
├─ styles.css         extracted from web/index.html so both clients match
├─ serve.py           tiny local dev server (port 8080 by default)
├─ README.md          this file
└─ js/
   ├─ app.js          screen navigation + orchestration (mirrors PodSyncAPI)
   ├─ recorder.js     AudioWorklet-based mic capture + WAV encoder
   ├─ worklet.js      AudioWorkletProcessor (runs on audio thread)
   ├─ relay.js        WebSocket client mirroring network.py
   ├─ library.js      HTTP client mirroring library.py
   └─ config.js       localStorage-backed config (mirrors config.py)
```

## What's NOT in this build yet

- **Admin panel** (desktop has one; trivial to add but non-critical)
- **Streaming to OPFS during recording** — currently accumulates the
  whole Float32 buffer in memory, which is fine up to ~2 hours of mono
  48 kHz (~700 MB). For multi-hour sessions we'd stream to OPFS or
  trigger the File System Access API. Easy add.
- **Mic disconnect / reconnect UI** — browsers handle hotplug
  automatically most of the time; if we ever need an explicit flow
  it mirrors the desktop's pause/resume.

## Known caveats

- **Browser must grant mic permission** on first record. This is a
  one-time prompt per origin.
- **Device labels are blank until mic permission is granted** at least
  once in that origin. We force a `getUserMedia` call on entry to the
  Test Audio and Settings screens to populate them.
- **Chrome/Edge recommended**. Firefox works for capture but has some
  AudioWorklet quirks; Safari works for capture but lacks the File
  System Access API.
- **HTTPS in production is required** by `getUserMedia`. `localhost`
  gets a pass during development.
