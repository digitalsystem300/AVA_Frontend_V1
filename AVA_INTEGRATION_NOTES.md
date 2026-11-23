# AVA Backend V1 integration notes

## Files in this package
| File | Status |
|---|---|
| `index.html` | **Changed** (integration points only; see `CHANGES.diff`). CSS, HTML markup, avatar/VRM, animation, voice and card UI are byte-identical to the original. |
| `ava-config.js` | **New.** The only place the backend URL is written (`backendUrl`). |
| `ava-client.js` | **New.** Health check, ticket + WebSocket session, reconnection, REST helpers. No UI code. |
| `CHANGES.diff` | Full diff of `index.html` against the file you supplied. |

Not included because they were not supplied: `assets/` (VRM model, background), `manifest.json`, `favicon.ico`. Copy these three files into your existing project root next to them.

## Set-up (3 steps)
1. Copy `index.html`, `ava-config.js`, `ava-client.js` into your project, replacing `index.html`.
2. On Render set **`CORS_ORIGINS`** to the exact origin the frontend is served from (e.g. `https://my-app.example.com`, no trailing slash). The browser origin is also checked on the WebSocket.
3. Open the app and tap "Tap to start": it asks once for the backend **`API_KEY`** and keeps it in this browser's localStorage (`ava.accessKey`). It is never in the source or in a URL.

> The backend at `https://ava-backend-v1.onrender.com` must be the `AVA_Backend_V1` code. When checked, its `/` answered `{"project":"AVA Backend V1","message":"Hello World!","status":"running"}`, which is not that code (`/` should answer `{"name":"AVA_Backend_V1","version":"1.0.0","status":"running"}`). Redeploy the `AVA_Backend_V1.zip` project there first.

## Protocol used (from `AVA_Backend_V1/docs/API_DOCUMENTATION.md` and its source)
| Purpose | Call |
|---|---|
| Health / wake-up | `GET /health` (sent when the page opens) |
| WebSocket ticket | `POST /api/ws-token` with header `X-API-Key` -> `{token, expires_in}` (single use, 60 s) |
| Chat | `wss://…/ws?token=…`; send `session.start {modality:"AUDIO"}`, wait for `status: session.ready`, send `text.input {text}`; collect `text.output` until `turn.complete` |
| Tool results / cards | `card.open {card:{id,card_type,title,content}}`, `card.close`; also `tool.start/result/error` |
| News / search voice commands | `POST /api/news`, `POST /api/search` with `X-API-Key` |

Backend card content is converted to the field names the existing card renderers use (`fromAva` in `index.html`). Reconnect: a fresh ticket and session are opened on the next message after a drop; a ping checks that an idle socket is alive.

## What was removed
* `https://aryan-ai-backend-v2.vercel.app/api/chat` and the old request/response contract (`{message, messages, character, language}` -> `{success, reply}`), plus the local history array.
* `window.JARVIS_CONFIG` (`infoApi`, `voiceWs`) and the generic `cards.connect(url)` WebSocket and `viaBackend()` helper that existed only for the old backend.

## Known limitations (be aware)
* **Voice stays browser-based** (speech recognition in, browser voice out, same lip-sync). Real-time PCM audio streaming to Gemini is supported by the backend but is **not wired** in this UI. Gemini's audio replies are received and ignored; the spoken text is the reply transcription.
* **Weather cards opened by Gemini** show *Rain probability / Sunrise / Sunset* as "Data unavailable": Backend V1 does not return them. The client already reads `rain_probability_percent`, `sunrise`, `sunset` if the backend adds them later.
* Voice commands for **weather, currency and time** still use Open-Meteo/Frankfurter directly from the browser, exactly as before (these are not the old backend). News, search and chat go through AVA.
* `open_card` (free-text card) has no renderer in this UI and is ignored.
* Context is held by the Gemini session on the server; after a full reconnect a new session starts (the old app resent the last 20 messages with each request).
* Render free instances sleep after 15 minutes; the first message after idle can take about a minute.
* News needs `NEWS_API_KEY` (NewsAPI's free plan is for development/testing only); search needs `SEARCH_API_KEY`.
