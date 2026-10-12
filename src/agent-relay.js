// Nova Agent online: its chat, Missions, Quests, Calendar and Visualizer, from the studio PC.
//
// Nova Agent runs on the studio PC, which can't be reached from the internet. So the PC dials
// out: it opens a WebSocket to /nova-agent/link with its key (AGENT_NOVA_KEY), and keeps it open.
// One Durable Object (AgentLink) holds that socket. When a signed-in staff member's browser asks
// for one of Nova Agent's own addresses here (RELAYED below), the request goes down the socket,
// the PC answers it as if it were asked locally (src/relay.ts in Nova Agent), and the answer
// comes back up, streamed (the live /events feeds stay open).
//
//   browser ──GET /quests/state──▶ worker ──▶ AgentLink ══ WebSocket ══▶ studio PC
//                                                       ◀══ res + chunks ══
//
// PC off (or not connected): 503 { pcOffline: true } straight away, so the page can say so.
// Only Nova Agent's own addresses are passed on, and only to signed-in Portal staff
// (the Visualizer's ones to admins); the PC checks the same list again.
//
// Frames on the socket (JSON text; bodies base64):
//   to the PC   { t: "req", id, method, path, headers, staff, body: bool }
//               { t: "body", id, d } … { t: "end", id }        (only when body is true)
//               { t: "cancel", id }                              (the browser went away)
//   from the PC { t: "res", id, status, headers }  { t: "chunk", id, d }  { t: "done", id }
//               { t: "error", id, message }
//   "ping" → "pong" (answered by the runtime without waking the object)

import { DurableObject } from "cloudflare:workers";
import { requireStaff } from "./portal/auth.js";

// ---- What's passed on ----
// Nova Agent's own addresses (see src/visualizer/server.ts in Nova Agent). Everything else
// (Portal's /auth, /staff, /app/api, the panels' pages…) is answered here as usual.
// admin: the Visualizer's addresses show every step, with client names and the AI's prompts.
export const RELAYED = [
  { methods: ["GET"], path: /^\/status$/ },
  { methods: ["GET"], path: /^\/quests\/(state|events)$/ },
  // Each person's own Agent conversation, kept on the PC (who's asking goes with every request)
  { methods: ["GET"], path: /^\/chat\/history$/ },
  { methods: ["POST"], path: /^\/actions\/chat\/(clear|adopt)$/ },
  { methods: ["POST"], path: /^\/actions\/(chat|missions|quests|blocks|rhythm|replan)$/ },
  { methods: ["POST"], path: /^\/actions\/(missions|quests)\/[\w-]+(\/(refine|export))?$/ },
  { methods: ["POST"], path: /^\/actions\/files\/[\w-]+\/remove$/ },
  { methods: ["GET"], path: /^\/files\/(list|[\w-]+\/[^/]+)$/ },
  { methods: ["GET", "PUT"], path: /^\/calendar-api\/data$/ },
  { methods: ["GET"], path: /^\/calendar-api\/events$/ },
  { methods: ["GET"], path: /^\/(events|cache|tasks)$/, admin: true },
  { methods: ["POST"], path: /^\/actions\/(run\/[\w-]+|forget)$/, admin: true },
  // The Fixer: its state, pictures and taps (Approve, Reject, Ask for a tweak...) are for admins
  { methods: ["GET"], path: /^\/fixer-api\/(state|jobs\/[\w-]+|shots\/[\w-]+\/[\w-]+\.png)$/, admin: true },
  { methods: ["POST"], path: /^\/actions\/fixer\/(check|settings|quests|(quests|suggestions|issues|jobs)\/[\w-]+)$/, admin: true },
  // Social posts' pictures and videos, kept on the studio computer (src/social-media.ts in Nova
  // Agent): see them, add one, take one out of a draft
  { methods: ["GET"], path: /^\/social-media\/[a-f0-9]{32}\.(jpg|png|webp|gif|mp4|mov)$/ },
  { methods: ["POST"], path: /^\/actions\/social-media(\/[a-f0-9]{32}\/remove)?$/ },
];

// A path that's what it looks like: no dot segments, encoded slashes or dots, backslashes
// (so nothing can be dressed up as an allowed address and land somewhere else on the PC)
export function plainPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 512) return false;
  if (/%(2e|2f|5c|00)|\\|\/\.\.?(\/|$)|\/\//i.test(pathname)) return false;
  try {
    decodeURIComponent(pathname);
  } catch {
    return false;
  }
  return true;
}

// The rule for this request, or null
export function relayRule(method, pathname) {
  if (!plainPath(pathname)) return null;
  return RELAYED.find((r) => r.methods.includes(method) && r.path.test(pathname)) || null;
}

// Could this address be one of Nova Agent's? (any method: wrong methods get 405, not the panels)
export function isRelayed(pathname) {
  return RELAYED.some((r) => r.path.test(pathname));
}

const MAX_BODY = 25 * 1024 * 1024;
const PIECE = 256 * 1024;
// Long enough for a chat that uses the Acuity helper
const ANSWER_WITHIN_MS = 5 * 60_000;
const SEND_HEADERS = ["accept", "content-type", "content-length", "x-nova-visualizer", "x-nova-rev", "x-nova-app", "last-event-id", "range"];
const KEEP_HEADERS = ["content-type", "cache-control", "content-disposition", "content-range", "accept-ranges", "last-modified", "etag", "x-nova-rev", "x-nova-size"];

const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
export const PC_OFFLINE = { error: "The studio computer is off or offline", pcOffline: true };

function link(env) {
  return env.AGENT_LINK.get(env.AGENT_LINK.idFromName("studio-pc"));
}

// ---- A browser asks for one of Nova Agent's addresses ----
export async function handleRelay(request, env, ctx) {
  const url = new URL(request.url);
  const rule = relayRule(request.method, url.pathname);
  if (!rule) {
    if (!plainPath(url.pathname)) return json({ error: "Not found" }, 404);
    return json({ error: "Not allowed" }, 405, { Allow: RELAYED.filter((r) => r.path.test(url.pathname)).flatMap((r) => r.methods).join(", ") });
  }
  const staff = await requireStaff(request, env);
  if (!staff) return json({ error: "Sign in with Portal first", signedIn: false }, 401);
  if (rule.admin && staff.role !== "admin") return json({ error: "For admins only" }, 403);
  // Changes only from this site's own pages
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    if ((origin && origin !== url.origin) || (site && site !== "same-origin")) return json({ error: "Forbidden" }, 403);
  }
  const size = Number(request.headers.get("Content-Length") || 0);
  if (size > MAX_BODY) return json({ error: "That's too big to send to the studio computer (25 MB at most)" }, 413);
  if (!env.AGENT_LINK) return json(PC_OFFLINE, 503);

  const headers = new Headers();
  for (const h of SEND_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("X-Nova-Staff", JSON.stringify({ id: staff.id, name: staff.display_name, role: staff.role }));
  const stub = link(env);
  const res = await stub.fetch(new Request("https://agent-link/relay" + url.pathname + url.search, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
  }));
  const id = res.headers.get("X-Nova-Relay-Id");
  if (!id || !res.body) return res;
  // Passed through here so that when the browser goes away (a live feed closed), the PC is told
  // to stop: the stream breaking doesn't reach the link object by itself
  const out = new Headers(res.headers);
  out.delete("X-Nova-Relay-Id");
  let ended = false;
  const { readable, writable } = new TransformStream({ flush: () => void (ended = true) });
  const piping = res.body
    .pipeTo(writable)
    .catch(() => {})
    .then(() => ended || stub.fetch(new Request("https://agent-link/cancel?id=" + encodeURIComponent(id))).catch(() => {}));
  if (ctx && ctx.waitUntil) ctx.waitUntil(piping);
  return new Response(readable, { status: res.status, headers: out });
}

// ---- Nova Bot itself asks the PC for something (a social post's picture, for Meta) ----
// Only addresses on the list above, as a staff member called "Nova Bot" (the PC checks the list
// again). PC off: 503.
const NOVA_BOT = { id: "nova-bot", name: "Nova Bot", role: "staff" };
export async function askPC(env, path, { headers = {} } = {}) {
  if (!relayRule("GET", path.split("?")[0])) return json({ error: "Not allowed" }, 403);
  if (!env.AGENT_LINK) return json(PC_OFFLINE, 503);
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) if (SEND_HEADERS.includes(k.toLowerCase()) && v) h.set(k, v);
  h.set("X-Nova-Staff", JSON.stringify(NOVA_BOT));
  const res = await link(env).fetch(new Request("https://agent-link/relay" + path, { headers: h }));
  if (!res.headers.get("X-Nova-Relay-Id")) return res;
  const out = new Headers(res.headers);
  out.delete("X-Nova-Relay-Id");
  return new Response(res.body, { status: res.status, headers: out });
}

// ---- The PC connects (GET /nova-agent/link, a WebSocket, with Nova Agent's key) ----
export async function handleLink(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.AGENT_NOVA_KEY || !(await sameKey(key, env.AGENT_NOVA_KEY))) return json({ error: "Not allowed" }, 401);
  if (request.headers.get("Upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
  if (!env.AGENT_LINK) return json({ error: "The link isn't set up on this worker" }, 503);
  return link(env).fetch(new Request("https://agent-link/connect", { headers: request.headers }));
}

// Is the PC connected? (for staff pages; nothing secret)
export async function linkStatus(request, env) {
  if (!(await requireStaff(request, env))) return json({ error: "Sign in with Portal first", signedIn: false }, 401);
  if (!env.AGENT_LINK) return json({ connected: false });
  return link(env).fetch(new Request("https://agent-link/status"));
}

// ---- Calendar online uses Nova Agent's calendar ----
// Its page gets the same small script as on the PC (calendar-sync.js, copied in at build time from
// Nova Agent, so it loads even when the PC is off), so it shows and saves Nova Agent's calendar. PC off: it keeps this browser's last copy, and changes wait in
// the browser and save when the PC is back (calendar-sync.js does both).
export async function calendarPage(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL("/calendar/", request.url), { headers: request.headers }));
  if (!res.ok || !(res.headers.get("Content-Type") || "").includes("text/html")) return res;
  const html = (await res.text()).replace('<script src="js/store.js"></script>', '<script src="/calendar-sync.js"></script>\n<script src="js/store.js"></script>');
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Cache-Control", "no-cache");
  return new Response(html, { status: 200, headers });
}

async function sameKey(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const p = new Uint8Array(x);
  const q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- The link itself: one Durable Object holding the PC's socket ----
export class AgentLink extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The PC's heartbeat is answered without waking the object
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Requests waiting on the PC: id → { head, writer, timer }
    this.waiting = new Map();
  }

  pc() {
    return this.ctx.getWebSockets("pc")[0] || null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.connect();
    if (url.pathname === "/status") {
      const ws = this.pc();
      const at = ws ? ws.deserializeAttachment()?.since : null;
      return json({ connected: Boolean(ws), since: at || null });
    }
    if (url.pathname.startsWith("/relay/")) return this.relay(request, url.pathname.slice("/relay".length) + url.search);
    if (url.pathname === "/cancel") {
      this.cancel(url.searchParams.get("id") || "");
      return new Response(null, { status: 204 });
    }
    return json({ error: "Not found" }, 404);
  }

  connect() {
    // A new connection from the PC replaces the old one (a restart, or a dropped network)
    for (const old of this.ctx.getWebSockets("pc")) {
      try {
        old.close(4001, "replaced");
      } catch {}
    }
    this.failAll();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, ["pc"]);
    server.serializeAttachment({ since: new Date().toISOString() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async relay(request, path) {
    const ws = this.pc();
    if (!ws) return json(PC_OFFLINE, 503);
    const id = crypto.randomUUID();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let answer;
    const head = new Promise((resolve) => (answer = resolve));
    const entry = { answer, writer, answered: false, timer: 0 };
    entry.timer = setTimeout(() => this.finish(id, json({ error: "The studio computer didn't answer in time" }, 504)), ANSWER_WITHIN_MS);
    this.waiting.set(id, entry);

    const headers = Object.fromEntries(request.headers);
    let staff = null;
    try {
      staff = JSON.parse(headers["x-nova-staff"] || "null");
    } catch {}
    delete headers["x-nova-staff"];
    const hasBody = request.body !== null;
    try {
      ws.send(JSON.stringify({ t: "req", id, method: request.method, path, headers, staff, body: hasBody }));
      if (hasBody) {
        const reader = request.body.getReader();
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BODY) {
            reader.cancel().catch(() => {});
            this.send({ t: "cancel", id });
            this.finish(id, json({ error: "That's too big to send to the studio computer (25 MB at most)" }, 413));
            break;
          }
          for (let i = 0; i < value.byteLength; i += PIECE) this.send({ t: "body", id, d: toBase64(value.subarray(i, i + PIECE)) });
        }
        if (this.waiting.has(id)) this.send({ t: "end", id });
      }
    } catch {
      this.finish(id, json(PC_OFFLINE, 503));
    }
    // The browser went away before the answer: tell the PC to stop
    request.signal?.addEventListener?.("abort", () => this.cancel(id));
    // An error answers with a whole response; the PC's answer streams through `readable`
    const out = await head;
    if (out instanceof Response) return out;
    out.headers.set("X-Nova-Relay-Id", id);
    return new Response(readable, out);
  }

  send(frame) {
    const ws = this.pc();
    if (!ws) throw new Error("no PC");
    ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  // Answer a waiting request with a whole response (an error), and forget it
  finish(id, response) {
    const entry = this.waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.waiting.delete(id);
    if (!entry.answered) {
      entry.answered = true;
      entry.answer(response);
    }
    entry.writer.close().catch(() => {});
  }

  cancel(id) {
    if (!this.waiting.has(id)) return;
    try {
      this.send({ t: "cancel", id });
    } catch {}
    const entry = this.waiting.get(id);
    clearTimeout(entry.timer);
    this.waiting.delete(id);
    entry.writer.abort().catch(() => {});
  }

  failAll() {
    for (const [id, entry] of this.waiting) {
      if (!entry.answered) this.finish(id, json(PC_OFFLINE, 503));
      else {
        clearTimeout(entry.timer);
        this.waiting.delete(id);
        entry.writer.close().catch(() => {});
      }
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let frame;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    const entry = this.waiting.get(frame.id);
    if (!entry) {
      // Something this object no longer waits for (the browser left, or the object restarted)
      if (frame.t === "res" || frame.t === "chunk") this.send({ t: "cancel", id: frame.id });
      return;
    }
    if (frame.t === "res" && !entry.answered) {
      entry.answered = true;
      clearTimeout(entry.timer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(frame.headers || {})) if (KEEP_HEADERS.includes(k.toLowerCase())) headers.set(k, String(v));
      if ((headers.get("Content-Type") || "").includes("text/event-stream")) headers.set("Cache-Control", "no-cache, no-transform");
      headers.set("X-Nova-Agent", "studio-pc");
      const status = Number(frame.status) || 502;
      const noBody = status === 204 || status === 304;
      if (noBody) {
        entry.answer(new Response(null, { status, headers }));
        this.waiting.delete(frame.id);
        entry.writer.close().catch(() => {});
        return;
      }
      entry.answer({ status, headers });
      return;
    }
    if (frame.t === "chunk") {
      entry.writer.write(fromBase64(frame.d)).catch(() => this.cancel(frame.id));
      return;
    }
    if (frame.t === "done") {
      this.waiting.delete(frame.id);
      clearTimeout(entry.timer);
      entry.writer.close().catch(() => {});
      return;
    }
    if (frame.t === "error") {
      if (!entry.answered) this.finish(frame.id, json({ error: frame.message || "The studio computer couldn't answer that" }, 502));
      else {
        this.waiting.delete(frame.id);
        entry.writer.abort().catch(() => {});
      }
    }
  }

  async webSocketClose(ws) {
    if (!this.pc() || this.pc() === ws) this.failAll();
  }

  async webSocketError(ws) {
    if (!this.pc() || this.pc() === ws) this.failAll();
  }
}
