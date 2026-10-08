// Nova Agent is the one app: its page is the main address, and the panels open only inside it.
// A panel opened on its own (the browser says "document") goes to Nova Agent with that panel
// open; inside Nova Agent's viewer (the browser says "iframe") it loads as itself.
// Run: npm test
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { STAFF_AUTH } from "./sign-in.js";

const BASE = "https://novacane-worker.test";
async function get(path, init = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { redirect: "manual", ...init }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const onItsOwn = { headers: { "Sec-Fetch-Dest": "document" } };
const inside = { headers: { "Sec-Fetch-Dest": "iframe" } };

describe("a panel opened on its own opens inside Nova Agent", () => {
  it.each([
    ["/portal/", "/portal/"],
    ["/portal/?view=chats", "/portal/?view=chats"],
    ["/portal/index.html", "/portal/index.html"],
    ["/calendar/", "/calendar/"],
    ["/notes/", "/notes/"],
    ["/app/memory/?scope=studio", "/app/memory/?scope=studio"],
    ["/observatory/", "/observatory/"],
    ["/lossless/?room=abc", "/lossless/?room=abc"],
    ["/admin", "/admin"],
    ["/admin/links", "/admin/links"],
    ["/visualizer", "/visualizer"],
  ])("%s → /?open=%s", async (from, address) => {
    const res = await get(from, onItsOwn);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${BASE}/?open=${encodeURIComponent(address)}`);
  });

  it("Hub's old address still goes to Portal first (then into Nova Agent)", async () => {
    const res = await get("/app/?view=alerts", onItsOwn);
    expect(res.headers.get("Location")).toBe(`${BASE}/portal/?view=alerts`);
  });
});

describe("inside Nova Agent the panels are themselves", () => {
  it.each(["/portal/", "/calendar/", "/notes/", "/app/memory/", "/observatory/", "/lossless/", "/visualizer"])("%s isn't redirected", async (path) => {
    const res = await get(path, inside);
    expect(res.status).not.toBe(302);
  });

  it("the admin pages can be shown inside Nova Agent (same site only)", async () => {
    const res = await get("/admin/links", { headers: { ...STAFF_AUTH, "Sec-Fetch-Dest": "iframe" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(await res.text()).toContain("/shared/inside.js");
  });
});

describe("what isn't a page stays as it is", () => {
  it.each(["/admin/report.csv", "/lossless/ice", "/lossless/ws", "/admin/google", "/admin/google/callback", "/app/api/me", "/portal/app.js", "/calendar/js/app.js"])("%s isn't sent to Nova Agent", async (path) => {
    const res = await get(path, onItsOwn);
    expect(res.headers.get("Location") || "").not.toContain("/?open=");
  });

  it("the website chat still POSTs to the main address", async () => {
    const res = await get("/", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403); // routed to the chat (which turns other websites away), not the page
  });

  it("Nova Agent's own page is the main address", async () => {
    const res = await get("/", onItsOwn);
    expect(res.status).not.toBe(302);
    expect(await res.text()).toContain("Nova Agent");
  });
});
