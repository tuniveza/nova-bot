// Nova Agent online: its own addresses go to the studio PC over the link it opens.
// The tests play the PC: they open /nova-agent/link with Nova Agent's key and answer frames.
// Run: npm test
import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { calendarPage, plainPath, relayRule } from "../src/agent-relay.js";
import { sha256 } from "../src/portal/auth.js";
import { STAFF_AUTH } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
const KEY = "agent-nova-test-key";

// (Not waiting on the request's leftover work: a relayed answer streams through it, and that
// only finishes once the test reads the body)
async function call(path, init = {}) {
  const ctx = createExecutionContext();
  return worker.fetch(new Request(BASE + path, { redirect: "manual", ...init }), env, ctx);
}

// The test plays the studio PC: connect, and answer each request with `reply(frame, pc)`
async function connectPc(reply) {
  const res = await call("/nova-agent/link", { headers: { Authorization: `Bearer ${KEY}`, Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  ws.accept();
  const seen = [];
  const bodies = new Map();
  const pc = {
    ws,
    seen,
    send: (frame) => ws.send(JSON.stringify(frame)),
    text: (id, status, text, type = "application/json") => {
      pc.send({ t: "res", id, status, headers: { "content-type": type, "set-cookie": "nope=1" } });
      pc.send({ t: "chunk", id, d: btoa(text) });
      pc.send({ t: "done", id });
    },
  };
  ws.addEventListener("message", (event) => {
    if (event.data === "pong") return;
    const frame = JSON.parse(event.data);
    seen.push(frame);
    if (frame.t === "req" && !frame.body) reply(frame, pc, "");
    if (frame.t === "req" && frame.body) bodies.set(frame.id, { req: frame, text: "" });
    if (frame.t === "body") bodies.get(frame.id).text += atob(frame.d);
    if (frame.t === "end") reply(bodies.get(frame.id).req, pc, bodies.get(frame.id).text);
  });
  return pc;
}

async function signInAs(id, role) {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const token = `test-${id}-session`;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO staff (id, email, password_hash, display_name, role, status, created_at, planet_seed, index_partition) VALUES (?, ?, NULL, ?, ?, 'active', ?, ?, ?)").bind(id, `${id}@novacane.test`, id, role, now, id, `staff:${id}`),
    env.DB.prepare("INSERT OR REPLACE INTO sessions (id, staff_id, kind, created_at, expires_at, last_seen_at) VALUES (?, ?, 'cookie', ?, ?, ?)").bind(await sha256(token), id, now, later, now),
  ]);
  return { Cookie: `nova_session=${token}` };
}

describe("which addresses go to the PC", () => {
  it("Nova Agent's own, with the right methods", () => {
    expect(relayRule("GET", "/status")).toBeTruthy();
    expect(relayRule("GET", "/quests/state")).toBeTruthy();
    expect(relayRule("POST", "/actions/chat")).toBeTruthy();
    expect(relayRule("POST", "/actions/quests/q-123")).toBeTruthy();
    expect(relayRule("POST", "/actions/missions/m-1/refine")).toBeTruthy();
    expect(relayRule("PUT", "/calendar-api/data")).toBeTruthy();
    expect(relayRule("GET", "/files/abc/report.pdf")).toBeTruthy();
    expect(relayRule("GET", "/events").admin).toBe(true);
    expect(relayRule("GET", "/actions/chat")).toBeNull();
    expect(relayRule("DELETE", "/quests/state")).toBeNull();
    // Files Nova Agent wrote: the list, one to read, removing one; a mission saved as a file
    expect(relayRule("GET", "/files/list")).toBeTruthy();
    expect(relayRule("POST", "/actions/files/f-1/remove")).toBeTruthy();
    expect(relayRule("POST", "/actions/missions/m-1/export")).toBeTruthy();
    expect(relayRule("POST", "/files/abc/report.pdf")).toBeNull();
    // Pages and scripts this worker serves itself (the Visualizer's page, Calendar's sync script)
    expect(relayRule("GET", "/visualizer")).toBeNull();
    expect(relayRule("GET", "/calendar-sync.js")).toBeNull();
  });

  it("never Portal's API or the staff pages", () => {
    for (const path of ["/auth/me", "/auth/login", "/staff", "/staff/x", "/app/api/me", "/portal/", "/", "/admin"]) {
      for (const method of ["GET", "POST"]) expect(relayRule(method, path)).toBeNull();
    }
  });

  it("not even dressed up", () => {
    for (const path of ["/quests/../auth/me", "/quests/%2e%2e/auth/me", "/files/x/%2e%2e", "/files/..%2fauth/me", "/files/a%2Fb/c", "/quests//state", "/files/a\\..\\auth", "/status%00"]) {
      expect(plainPath(path)).toBe(false);
      expect(relayRule("GET", path)).toBeNull();
    }
  });
});

describe("the link", () => {
  it("needs Nova Agent's key", async () => {
    expect((await call("/nova-agent/link", { headers: { Upgrade: "websocket" } })).status).toBe(401);
    expect((await call("/nova-agent/link", { headers: { Authorization: "Bearer wrong", Upgrade: "websocket" } })).status).toBe(401);
    expect((await call("/nova-agent/link", { headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(426);
  });

  it("only signed-in staff can use it", async () => {
    const res = await call("/status");
    expect(res.status).toBe(401);
    expect((await res.json()).signedIn).toBe(false);
  });

  it("says straight away when the PC is off", async () => {
    const res = await call("/status", { headers: STAFF_AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ pcOffline: true });
    const status = await call("/nova-agent/link/status", { headers: STAFF_AUTH });
    expect(await status.json()).toMatchObject({ connected: false });
  });

  it("wrong method: not passed on, and not the panels either", async () => {
    expect((await call("/actions/chat", { headers: STAFF_AUTH })).status).toBe(405);
    // The address parser resolves this to /auth/me, which Portal answers here, not the PC
    const tricked = await call("/quests/%2e%2e/auth/me", { headers: STAFF_AUTH });
    expect(tricked.headers.get("X-Nova-Agent")).toBeNull();
  });
});

describe("through to the PC and back", () => {
  it("a request and its answer, with who's asking (and no cookies passed on)", async () => {
    const pc = await connectPc((req, pc) => pc.text(req.id, 200, JSON.stringify({ path: req.path, staff: req.staff, cookie: req.headers.cookie || null })));
    const res = await call("/quests/state?x=1", { headers: STAFF_AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("X-Nova-Agent")).toBe("studio-pc");
    const body = await res.json();
    expect(body.path).toBe("/quests/state?x=1");
    expect(body.staff).toMatchObject({ id: "test-admin", role: "admin" });
    expect(body.cookie).toBeNull();
    const status = await call("/nova-agent/link/status", { headers: STAFF_AUTH });
    expect(await status.json()).toMatchObject({ connected: true });
    pc.ws.close();
  });

  it("a chat message (a body) gets there whole", async () => {
    const pc = await connectPc((req, pc, text) => pc.text(req.id, 200, JSON.stringify({ method: req.method, got: JSON.parse(text), header: req.headers["x-nova-visualizer"] })));
    const res = await call("/actions/chat", {
      method: "POST",
      headers: { ...STAFF_AUTH, "Content-Type": "application/json", "X-Nova-Visualizer": "1", Origin: BASE, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello ✦" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: "POST", got: { messages: [{ role: "user", content: "hello ✦" }] }, header: "1" });
    pc.ws.close();
  });

  it("changes only from this site's own pages", async () => {
    const pc = await connectPc((req, pc) => pc.text(req.id, 200, "{}"));
    const res = await call("/actions/chat", { method: "POST", headers: { ...STAFF_AUTH, "Content-Type": "application/json", Origin: "https://elsewhere.example" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(pc.seen.filter((f) => f.t === "req")).toHaveLength(0);
    pc.ws.close();
  });

  it("the Visualizer's addresses are for admins", async () => {
    const pc = await connectPc((req, pc) => pc.text(req.id, 200, "[]"));
    const staff = await signInAs("plain-staff", "staff");
    expect((await call("/tasks", { headers: staff })).status).toBe(403);
    expect((await call("/quests/state", { headers: staff })).status).toBe(200);
    expect((await call("/tasks", { headers: STAFF_AUTH })).status).toBe(200);
    pc.ws.close();
  });

  it("live feeds stream, and the PC is told when the browser leaves", async () => {
    const pc = await connectPc((req, pc) => {
      pc.send({ t: "res", id: req.id, status: 200, headers: { "content-type": "text/event-stream" } });
      pc.send({ t: "chunk", id: req.id, d: btoa("event: changed\ndata: 1\n\n") });
      pc.stream = req.id;
    });
    const res = await call("/quests/events", { headers: STAFF_AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = res.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: changed");
    await reader.cancel();
    // The next ping finds nobody listening: the PC hears "cancel"
    for (let i = 0; i < 20 && !pc.seen.some((f) => f.t === "cancel"); i++) {
      pc.send({ t: "chunk", id: pc.stream, d: btoa("event: ping\ndata:\n\n") });
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(pc.seen.some((f) => f.t === "cancel" && f.id === pc.stream)).toBe(true);
    pc.ws.close();
  });

  it("the PC going away answers what's waiting", async () => {
    let close;
    const pc = await connectPc(() => close());
    close = () => pc.ws.close(1011, "gone");
    const res = await call("/status", { headers: STAFF_AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ pcOffline: true });
  });

  it("an error on the PC comes back as one", async () => {
    const pc = await connectPc((req, pc) => pc.send({ t: "error", id: req.id, message: "boom" }));
    const res = await call("/cache", { headers: STAFF_AUTH });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("boom");
    pc.ws.close();
  });
});

describe("Calendar online", () => {
  it("its page saves to Nova Agent's calendar (calendar-sync.js goes in before the app's store)", async () => {
    const page = '<html><head></head><body><script src="js/store.js"></script></body></html>';
    const fake = { ASSETS: { fetch: async () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", ETag: "x" } }) } };
    const res = await calendarPage(new Request(BASE + "/calendar/"), fake);
    const html = await res.text();
    expect(html).toContain('<script src="/calendar-sync.js"></script>\n<script src="js/store.js"></script>');
    expect(res.headers.get("ETag")).toBeNull();
  });
});
