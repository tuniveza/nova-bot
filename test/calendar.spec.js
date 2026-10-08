// Calendar: the events API (/app/api/calendar/items), Nova Agent's sync, and phone reminders
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { STAFF_COOKIE } from "./sign-in.js";
import { dueReminders, localToMs } from "../src/calendar/reminders.js";

const BASE = "https://novacane-worker.test";

async function call(path, { method = "GET", cookie = STAFF_COOKIE, body, headers = {} } = {}) {
  const ctx = createExecutionContext();
  const h = { Origin: BASE, "Content-Type": "application/json", ...headers };
  if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const agent = (body) => call("/nova-agent/calendar", { method: "POST", cookie: "", headers: { Authorization: "Bearer agent-nova-test-key" }, body });
const event = (id, extra = {}) => ({ kind: "event", title: "Mix review", start: "2026-10-09T14:00", end: "2026-10-09T15:00", updated: "2026-10-08T10:00:00.000Z", ...extra, id });

describe("calendar items", () => {
  it("needs a sign-in", async () => {
    expect((await call("/app/api/calendar/items", { cookie: "" })).status).toBe(401);
  });

  it("adds, lists, changes and deletes an event", async () => {
    const put = await call("/app/api/calendar/items/ev-1", { method: "PUT", body: event("ev-1", { location: "Studio A", color: "teal", reminders: [10, 60], repeat: { freq: "weekly", byDay: [1, 3] } }) });
    expect(put.status).toBe(200);
    expect(put.data.ok).toBe(true);
    let list = await call("/app/api/calendar/items");
    const saved = list.data.items.find((i) => i.id === "ev-1");
    expect(saved).toMatchObject({ title: "Mix review", location: "Studio A", color: "teal", reminders: [10, 60], repeat: { freq: "weekly", interval: 1, byDay: [1, 3] } });
    const rev = list.data.rev;

    await call("/app/api/calendar/items/ev-1", { method: "PUT", body: event("ev-1", { title: "Mix review v2", updated: "2026-10-08T11:00:00.000Z" }) });
    let since = await call(`/app/api/calendar/items?since=${rev}`);
    expect(since.data.items.map((i) => i.title)).toEqual(["Mix review v2"]);

    const del = await call("/app/api/calendar/items/ev-1?updated=2026-10-08T12:00:00.000Z", { method: "DELETE" });
    expect(del.data.ok).toBe(true);
    since = await call(`/app/api/calendar/items?since=${rev}`);
    expect(since.data.items).toEqual([expect.objectContaining({ id: "ev-1", deleted: true })]);
    // A first load leaves deleted ones out
    list = await call("/app/api/calendar/items");
    expect(list.data.items.find((i) => i.id === "ev-1")).toBeUndefined();
  });

  it("the latest change wins; an older one is told what's there", async () => {
    await call("/app/api/calendar/items/ev-2", { method: "PUT", body: event("ev-2", { title: "Newer", updated: "2026-10-08T12:00:00.000Z" }) });
    const older = await call("/app/api/calendar/items/ev-2", { method: "PUT", body: event("ev-2", { title: "Older", updated: "2026-10-08T09:00:00.000Z" }) });
    expect(older.data.ok).toBe(false);
    expect(older.data.current.title).toBe("Newer");
  });

  it("turns away junk, other websites, and changes to Nova Agent's plan", async () => {
    expect((await call("/app/api/calendar/items/x", { method: "PUT", body: { kind: "event", title: "no start" } })).status).toBe(400);
    expect((await call("/app/api/calendar/items/x", { method: "PUT", body: event("x"), headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("/app/api/calendar/items/quest-1", { method: "PUT", body: event("quest-1") })).status).toBe(403);
  });

  it("keeps day cards", async () => {
    const r = await call("/app/api/calendar/items/day-1", { method: "PUT", body: { kind: "day", id: "day-1", date: "2026-10-31", preset: "halloween", title: "Halloween", repeat: "yearly", updated: "2026-10-08T10:00:00.000Z" } });
    expect(r.data.ok).toBe(true);
    const list = await call("/app/api/calendar/items");
    expect(list.data.items.find((i) => i.id === "day-1")).toMatchObject({ kind: "day", date: "2026-10-31", repeat: "yearly" });
  });
});

describe("Nova Agent's copy on the PC", () => {
  it("needs Nova Agent's key", async () => {
    expect((await call("/nova-agent/calendar", { method: "POST", cookie: "", headers: { Authorization: "Bearer wrong" }, body: {} })).status).toBe(401);
  });

  it("sends its changes and gets everything else; sending twice changes nothing", async () => {
    await call("/app/api/calendar/items/from-phone", { method: "PUT", body: event("from-phone", { title: "Made on a phone" }) });
    const items = [event("pc-1", { title: "Made on the PC" }), event("quest-abc", { title: "A quest" }), { kind: "day", id: "pc-day", date: "2026-12-25", title: "Christmas", updated: "2026-10-08T10:00:00.000Z" }];
    const first = await agent({ since: 0, upserts: items });
    expect(first.status).toBe(200);
    expect(first.data.items.map((i) => i.id)).toEqual(expect.arrayContaining(["from-phone", "pc-1", "pc-day", "quest-abc"]));
    const again = await agent({ since: first.data.rev, upserts: items });
    expect(again.data.items).toEqual([]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_items WHERE id IN ('from-phone', 'pc-1', 'pc-day', 'quest-abc')").first("n");
    expect(count).toBe(4);
  });

  it("deletes, and hears back when its copy is older", async () => {
    await agent({ upserts: [event("pc-2", { updated: "2026-10-08T10:00:00.000Z" })] });
    await call("/app/api/calendar/items/pc-2", { method: "PUT", body: event("pc-2", { title: "Edited on a phone", updated: "2026-10-08T15:00:00.000Z" }) });
    const r = await agent({ upserts: [event("pc-2", { title: "Stale PC copy", updated: "2026-10-08T11:00:00.000Z" })] });
    expect(r.data.rejected.map((i) => i.title)).toEqual(["Edited on a phone"]);
    const del = await agent({ deletes: [{ id: "pc-2", updated: "2026-10-08T16:00:00.000Z" }] });
    expect(del.data.items.find((i) => i.id === "pc-2")).toBeUndefined();
    expect(await env.DB.prepare("SELECT deleted FROM calendar_items WHERE id = 'pc-2'").first("deleted")).toBe(1);
  });
});

describe("reminders", () => {
  it("UK time: summer and winter", () => {
    expect(new Date(localToMs("2026-07-01T14:00")).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(new Date(localToMs("2026-12-01T14:00")).toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("are due at the right minute, for repeats too, and all-day ones count from 09:00", () => {
    const events = [
      { id: "a", title: "Mix review", start: "2026-10-09T14:00", end: "2026-10-09T15:00", reminders: [10], location: "Studio A" },
      { id: "b", title: "Stand-up", start: "2026-10-05T09:30", end: "2026-10-05T09:45", reminders: [0], repeat: { freq: "daily" }, exdates: ["2026-10-09"] },
      { id: "c", title: "Release day", start: "2026-10-10T00:00", end: "2026-10-10T23:59", allDay: true, reminders: [1440] },
    ];
    const at = (stamp) => dueReminders(events, localToMs(stamp) + 30000).map((r) => r.key);
    expect(at("2026-10-09T13:50")).toEqual(["a|2026-10-09|10", "c|2026-10-10|1440"].filter((k) => k.startsWith("a")));
    expect(at("2026-10-08T09:30")).toEqual(["b|2026-10-08|0"]);
    expect(at("2026-10-09T09:30")).toEqual([]); // that one was deleted from the series
    expect(at("2026-10-09T09:00")).toEqual(["c|2026-10-10|1440"]);
    const one = dueReminders(events, localToMs("2026-10-09T13:50") + 1000)[0];
    expect(one.body).toBe("In 10 minutes · 14:00–15:00 · Studio A");
  });
});
