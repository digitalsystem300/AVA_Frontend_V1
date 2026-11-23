/*
 * AVA Backend V1 - central frontend configuration.
 *
 * This is the ONLY place the backend address is written. To point the frontend at another
 * deployment (or a local server), change `backendUrl` and nothing else:
 *   - HTTP API   -> <backendUrl>/api/...   and   <backendUrl>/health
 *   - WebSocket  -> same host, wss:// for https:// (ws:// for http://), path /ws
 *
 * NO secrets belong in this file. The backend access key (API_KEY) is never stored in the source:
 * the app asks for it once on this device and keeps it in this browser's localStorage ("ava.accessKey").
 * Gemini / news / search keys exist only on the backend.
 */
window.AVA_CONFIG = Object.freeze({
  backendUrl: "https://ava-backend-v1.onrender.com",

  // Gemini Live response modality. Native-audio Live models answer in AUDIO only; the reply text arrives
  // as output transcription and is spoken by the browser voice exactly like before.
  modality: "AUDIO",

  // Sent once in front of the first message of each Gemini session (the old backend received
  // language:"hinglish" with every request; AVA Backend V1 has no language field). "" disables it.
  replyStyleHint: "(Instruction for this conversation: answer in short, natural Hinglish - Hindi and English mixed the way the user speaks - in plain sentences that sound good when read aloud. No markdown, lists or emojis.)",

  // News needs a search term; used when the user just says "news".
  defaultNewsQuery: "latest news",

  // Timeouts (milliseconds). The first request after idle can take ~1 minute on a Render free instance:
  // /health (sent when the page opens) may wait up to wakeTimeoutMs; connecting retries for up to retryBudgetMs.
  wakeTimeoutMs: 75000,
  retryBudgetMs: 30000,
  replyTimeoutMs: 45000
});
