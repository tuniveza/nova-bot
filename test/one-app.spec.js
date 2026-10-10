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

// (Portal isn't here: it's also its own phone app, so its page decides; see "Portal's pages load as themselves")
describe("a panel opened on its own opens inside Nova Agent", () => {
  it.each([
    ["/calendar/", "/calendar/"],
    ["/notes/", "/notes/"],
    ["/app/memory/?scope=studio", "/app/memory/?scope=studio"],
    ["/observatory/", "/observatory/"],
    ["/lossless/?room=abc", "/lossless/?room=abc"],
    ["/admin", "/portal/?view=admin&page=%2Fadmin"],
    ["/admin/links", "/portal/?view=admin&page=%2Fadmin%2Flinks"],
    ["/visualizer", "/visualizer"],
  ])("%s → /agent/?open=%s", async (from, address) => {
    const res = await get(from, onItsOwn);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${BASE}/agent/?open=${encodeURIComponent(address)}`);
  });

  it("Portal's old address (/app/) opens Portal in Nova Agent, on the same view", async () => {
    const res = await get("/app/?view=alerts", onItsOwn);
    expect(res.headers.get("Location")).toBe(`${BASE}/agent/?open=${encodeURIComponent("/portal/?view=alerts")}`);
  });
});

describe("inside Nova Agent the panels are themselves", () => {
  it.each(["/portal/", "/calendar/", "/notes/", "/app/memory/", "/observatory/", "/lossless/", "/visualizer"])("%s isn't redirected", async (path) => {
    const res = await get(path, inside);
    expect(res.status).not.toBe(302);
  });

  it("Portal's pages load as themselves (the Portal phone app; the page itself opens Nova Agent in a browser tab)", async () => {
    for (const path of ["/portal/", "/portal/?app=1", "/portal/?view=alerts"]) {
      const res = await get(path, onItsOwn);
      expect(res.status, `${path} → ${res.headers.get("Location")}`).not.toBe(302);
    }
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
  it.each(["/admin/report.csv", "/lossless/ice", "/lossless/ws", "/admin/google", "/admin/google/callback", "/portal/app.js", "/calendar/js/app.js"])("%s isn't sent to Nova Agent", async (path) => {
    const res = await get(path, onItsOwn);
    expect(res.headers.get("Location") || "").not.toContain("/?open=");
  });

  it("the website chat still POSTs to the main address", async () => {
    const res = await get("/", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403); // routed to the chat (which turns other websites away), not the page
  });

  it("Nova Agent's own page is /agent/", async () => {
    const res = await get("/agent/", onItsOwn);
    expect(res.status).not.toBe(302);
    expect(await res.text()).toContain("Nova Agent");
  });

  it("a browser opening the main address goes on to Nova Agent", async () => {
    const res = await get("/", onItsOwn);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${BASE}/agent/`);
  });

  it("the main address is still Nova Bot's for anything else", async () => {
    const res = await get("/");
    expect(await res.text()).toBe("Novacane chatbot is running.");
  });

  it.each([
    ["/agent", ""],
    ["/agent/calendar", "?open=" + encodeURIComponent("/calendar/")],
    ["/agent/portal?view=chats", "?open=" + encodeURIComponent("/portal/?view=chats")],
    ["/agent/index", "?open=" + encodeURIComponent("/app/memory/")],
    ["/agent/admin", "?open=" + encodeURIComponent("/portal/?view=admin&page=%2Fadmin")],
  ])("%s opens Nova Agent%s", async (from, query) => {
    const res = await get(from, onItsOwn);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${BASE}/agent/${query}`);
  });
});

describe("/agent/ is the only address", () => {
  it.each([
    ["/anything-else", ""],
    ["/admin/enquiries", "?open=" + encodeURIComponent("/portal/?view=admin&page=%2Fadmin%2Fenquiries")],
    ["/app/api/me", "?open=" + encodeURIComponent("/portal/")],
    ["/studio/", "?open=" + encodeURIComponent("/portal/")],
    ["/crew/x", "?open=" + encodeURIComponent("/portal/x")],
    ["/index/", "?open=" + encodeURIComponent("/app/memory/")],
    ["/staff", ""],
    ["/nova-agent/next", ""],
    ["/agent/nothing", ""],
  ])("a browser opening %s goes to /agent/%s", async (from, query) => {
    const res = await get(from, onItsOwn);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${BASE}/agent/${query}`);
  });

  it.each(["/privacy", "/referral", "/book", "/admin/google/callback", "/agent/icon.svg", "/novabot.js", "/admin/report.csv"])("%s stays (a customer page, connecting Google, or a file)", async (path) => {
    const res = await get(path, onItsOwn);
    expect(res.headers.get("Location") || "").not.toContain("/agent/");
  });

  it("the apps' own requests (not pages) aren't redirected", async () => {
    const res = await get("/app/api/me");
    expect(res.status).not.toBe(302);
  });
});

describe("the apps' version check", () => {
  it("/app-version answers with the live version, never kept by the browser", async () => {
    const res = await get("/app-version", { headers: { "Sec-Fetch-Dest": "empty" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(typeof (await res.json()).version).toBe("string");
  });
});
