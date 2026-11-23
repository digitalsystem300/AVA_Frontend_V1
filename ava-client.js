/*
 * AVA Backend V1 client - transport only (no UI, no card rendering).
 *
 * Protocol (see AVA_Backend_V1/docs/API_DOCUMENTATION.md):
 *   GET  /health                      public
 *   POST /api/ws-token                header X-API-Key -> { token, expires_in }   (single-use WebSocket ticket)
 *   WS   /ws?token=<ticket>           JSON text frames
 *     -> {type:"session.start", modality}     <- {type:"status", state:"session.ready"}
 *     -> {type:"text.input", text}            <- text.output* ... turn.complete
 *     <- tool.start / tool.result / tool.error, card.open / card.close, error
 *   POST /api/news, /api/search       header X-API-Key
 *
 * The permanent API key is never put in a URL. It is typed in once by the owner and kept in localStorage.
 */

const KEY_STORAGE = "ava.accessKey";

export class AvaError extends Error {
  constructor(message, code) { super(message); this.name = "AvaError"; this.code = code || "error"; }
}

const readKey = () => { try { return localStorage.getItem(KEY_STORAGE) || ""; } catch (e) { return ""; } };
const writeKey = (v) => { try { if (v) localStorage.setItem(KEY_STORAGE, v); else localStorage.removeItem(KEY_STORAGE); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// HTTP-level failures are retried inside getToken (time budget); the session-level retry in ask() is only for dropped sockets.
const NO_RETRY = new Set(["unauthorized", "no_key", "rate_limited", "busy", "turn_timeout", "network", "timeout", "unavailable"]);
const RETRY_HTTP = new Set(["network", "timeout", "unavailable"]);

export function createAvaClient({ config, onEvent, onNotice }) {
  const cfg = config || {};
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const notify = typeof onNotice === "function" ? onNotice : () => {};

  let base;
  try {
    const u = new URL(cfg.backendUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error("protocol");
    base = u.origin + u.pathname.replace(/\/+$/, "");
  } catch (e) { throw new Error("AVA_CONFIG.backendUrl is missing or invalid (see ava-config.js)."); }
  const wsUrl = base.replace(/^http/i, "ws") + "/ws";
  const wakeMs = cfg.wakeTimeoutMs || 75000;
  const replyMs = cfg.replyTimeoutMs || 45000;
  const retryMs = cfg.retryBudgetMs || 30000; // how long to keep retrying while the backend may still be waking up

  /* ---------- access key (owner types it once; never in source code) ---------- */
  let declined = false;
  function getKey(interactive) {
    let k = readKey();
    if (k) return k;
    if (interactive && !declined && typeof window.prompt === "function") {
      k = (window.prompt("Enter your AVA backend access key (the API_KEY set on the server):") || "").trim();
      if (k) { writeKey(k); return k; }
      declined = true;
    }
    return "";
  }
  function requireKey() {
    const k = getKey(true);
    if (!k) throw new AvaError("AVA access key is not set.", "no_key");
    return k;
  }

  /* ---------- HTTP ---------- */
  async function request(path, { method = "GET", body, auth = false, timeoutMs = 20000 } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) headers["X-API-Key"] = requireKey();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, cache: "no-store", credentials: "omit" });
    } catch (e) {
      throw e && e.name === "AbortError"
        ? new AvaError("AVA backend did not respond in time (it may be waking up).", "timeout")
        : new AvaError(navigator.onLine === false ? "You appear to be offline." : "Cannot reach the AVA backend (network or CORS_ORIGINS).", "network");
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.ok) return data;
    const msg = data && data.error && data.error.message;
    if (res.status === 401) { writeKey(""); declined = false; throw new AvaError("AVA access key was rejected.", "unauthorized"); }
    if (res.status === 429) throw new AvaError("Too many requests - wait a moment.", "rate_limited");
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new AvaError(msg || "AVA backend is unavailable.", "unavailable");
    throw new AvaError(msg || "AVA backend error (HTTP " + res.status + ").", "http_" + res.status);
  }

  async function health() {
    const t0 = performance.now();
    try {
      const d = await request("/health", { timeoutMs: wakeMs });
      return { ok: !!d && d.status === "ok", ms: Math.round(performance.now() - t0), data: d };
    } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  }

  async function getToken() {
    const t0 = Date.now();
    for (let i = 0; ; i++) {
      try {
        const d = await request("/api/ws-token", { method: "POST", auth: true, timeoutMs: Math.min(wakeMs, 30000) });
        if (!d || typeof d.token !== "string" || !d.token) throw new AvaError("Backend returned no WebSocket token.", "bad_response");
        return d.token;
      } catch (e) {
        // A sleeping Render instance can answer with a proxy error or nothing for a while: back off and retry within the budget.
        const wait = Math.min(2000 * (i + 1), 8000);
        if (!RETRY_HTTP.has(e.code) || Date.now() - t0 + wait > retryMs) throw e;
        await sleep(wait);
      }
    }
  }

  /* ---------- WebSocket session ---------- */
  let ws = null, ready = false, connecting = null, turn = null, lastRx = 0, hinted = false;
  const listeners = new Set();

  function dispatch(m) { for (const fn of Array.from(listeners)) fn(m); }

  // Resolves on the first message accepted by `test`; rejects on backend error, socket close or timeout.
  function waitFor(test, ms, failMessage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new AvaError(failMessage, "ws_timeout")), ms);
      const fn = (m) => {
        if (m.type === "__close") return done(new AvaError(m.reason, "closed"));
        if (m.type === "error") return done(new AvaError((m.error && m.error.message) || "AVA backend error.", (m.error && m.error.code) || "error"));
        if (test(m)) done(null, m);
      };
      function done(err, val) { clearTimeout(timer); listeners.delete(fn); if (err) reject(err); else resolve(val); }
      listeners.add(fn);
    });
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) throw new AvaError("Not connected to the AVA backend.", "closed");
    ws.send(JSON.stringify(obj));
  }

  function hardClose() {
    const s = ws; ws = null; ready = false; hinted = false;
    if (s) { try { s.onmessage = s.onclose = s.onerror = null; s.close(); } catch (e) {} }
    dispatch({ type: "__close", reason: "Connection closed." });
  }

  function onMessage(sock, ev) {
    if (sock !== ws || typeof ev.data !== "string") return; // binary frames are not part of this protocol
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m.type !== "string") return;
    lastRx = Date.now();
    dispatch(m);
    if (turn) turn.onEvent(m);
    if (m.type === "card.open" || m.type === "card.close" || m.type === "card.request") { try { emit(m); } catch (e) { console.error("AVA card event failed:", e); } }
    if (m.type === "status" && (m.state === "session.closed" || m.state === "session.ended")) { ready = false; hinted = false; }
  }

  function onClose(sock, ev, opened) {
    if (sock !== ws) return;
    ws = null; ready = false; hinted = false;
    const code = ev && ev.code;
    const reason = !opened ? "Connection refused by the AVA backend (check the access key and CORS_ORIGINS)."
      : code === 1013 ? "AVA backend is busy (too many sessions)."
      : code === 1009 ? "Message too large for the AVA backend."
      : "Connection to the AVA backend was lost.";
    dispatch({ type: "__close", reason });
    if (turn) turn.fail(new AvaError(reason, "closed"));
  }

  async function openSocket() {
    const token = await getToken();
    const sock = new WebSocket(wsUrl + "?token=" + encodeURIComponent(token));
    ws = sock;
    let opened = false;
    sock.onopen = () => { opened = true; };
    sock.onmessage = (ev) => onMessage(sock, ev);
    sock.onclose = (ev) => onClose(sock, ev, opened);
    sock.onerror = () => {}; // onclose always follows
    lastRx = Date.now();
    await waitFor((m) => m.type === "status" && m.state === "connected", 20000, "AVA backend did not accept the WebSocket.");
  }

  async function startSession() {
    const ready_ = waitFor((m) => m.type === "status" && m.state === "session.ready", 30000, "Gemini Live session did not start in time.");
    send({ type: "session.start", modality: cfg.modality || "AUDIO" });
    await ready_;
    ready = true; hinted = false;
  }

  function ensureSession() {
    if (ws && ready && ws.readyState === 1) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      try { hardClose(); await openSocket(); await startSession(); }
      catch (e) { hardClose(); throw e; }
      finally { connecting = null; }
    })();
    return connecting;
  }

  // After a quiet spell a mobile connection can be dead while still looking open: ping before trusting it.
  async function alive() {
    if (Date.now() - lastRx < 20000) return true;
    const id = "p" + Date.now();
    try { const w = waitFor((m) => m.type === "pong" && m.request_id === id, 4000, "no pong"); send({ type: "ping", request_id: id }); await w; return true; }
    catch (e) { return false; }
  }

  function runTurn(text) {
    return new Promise((resolve, reject) => {
      const st = { text: "", open: 0, seen: 0 };
      const finish = (err, val) => { clearTimeout(timer); turn = null; if (err) reject(err); else resolve(val); };
      const timer = setTimeout(() => finish(new AvaError("The AI did not answer in time.", "turn_timeout")), replyMs);
      turn = {
        fail: (e) => finish(e),
        onEvent(m) {
          if (m.type === "text.output" && typeof m.text === "string") st.text += m.text;
          else if (m.type === "tool.start") { st.open++; st.seen++; }
          else if (m.type === "tool.result" || m.type === "tool.error") st.open = Math.max(0, st.open - 1);
          else if (m.type === "turn.complete") {
            const out = st.text.trim();
            if (st.open > 0 || (!out && st.seen > 0)) return; // the model is still waiting for / using a tool result
            if (!out) finish(new AvaError("The AI returned an empty reply.", "empty")); else finish(null, out);
          } else if (m.type === "error") finish(new AvaError((m.error && m.error.message) || "AVA backend error.", (m.error && m.error.code) || "error"));
          else if (m.type === "status" && m.state === "session.closed") finish(new AvaError("The AI session ended.", "closed"));
        }
      };
      try {
        const body = String(text).slice(0, 4000);
        send({ type: "text.input", text: !hinted && cfg.replyStyleHint ? cfg.replyStyleHint + "\n\n" + body : body });
        hinted = true;
      } catch (e) { finish(e); }
    });
  }

  async function ask(text) {
    if (turn) throw new AvaError("Previous request is still running.", "busy");
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ensureSession();
        if (!(await alive())) { hardClose(); await ensureSession(); }
        return await runTurn(text);
      } catch (e) {
        last = e;
        if (NO_RETRY.has(e.code)) break;
        hardClose(); // a fresh connection (and new single-use ticket) for the retry
      }
    }
    throw last;
  }

  // Called when the user taps "start": asks for the key if needed and opens the session in the background.
  function warmUp() {
    if (!getKey(true)) return Promise.resolve();
    return ensureSession().catch((e) => { if (e.code !== "no_key") notify("AVA backend: " + e.message); });
  }

  return {
    wsUrl, baseUrl: base,
    health, warmUp, ask,
    news: (query, pageSize) => request("/api/news", { method: "POST", auth: true, timeoutMs: 30000, body: { query, page_size: pageSize || 3 } }),
    search: (query, maxResults) => request("/api/search", { method: "POST", auth: true, timeoutMs: 30000, body: { query, max_results: maxResults || 4 } }),
    close() { hardClose(); }
  };
}
