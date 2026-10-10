// Nova Agent's panels online: Portal at /portal/ (so its old
// pages at /app/ go there), Index at /app/memory/. The addresses they had for a day go back too.
// Run: npm test
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

const BASE = "https://novacane-worker.test";
async function get(path, init = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { redirect: "manual", ...init }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("addresses the panels had for a day", () => {
  it.each([
    ["/studio/", "/portal/"],
    ["/studio/#nova", "/portal/#nova"],
    ["/crew/?invite=abc", "/portal/?invite=abc"],
    ["/index/?scope=studio", "/app/memory/?scope=studio"],
  ])("%s goes back to %s", async (from, to) => {
    const res = await get(from);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(BASE + to);
  });

  it("the staff API isn't moved", async () => {
    expect((await get("/app/api/me")).status).not.toBe(302);
  });
});

describe("Portal's old address (/app/) goes to Portal", () => {
  it.each([
    ["/app", "/portal/"],
    ["/app/", "/portal/"],
    ["/app/?view=alerts", "/portal/?view=alerts"],
    ["/app/index.html", "/portal/"],
    ["/app/app.js", "/portal/"],
  ])("%s goes to %s", async (from, to) => {
    const res = await get(from);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(BASE + to);
  });

  it.each(["/app/api/me", "/app/memory/", "/app/sw.js", "/app/manifest.webmanifest", "/app/icon-192.png", "/app/apple-touch-icon.png"])("%s stays put", async (path) => {
    expect((await get(path)).status).not.toBe(302);
  });

  it("only page visits move (a POST to the API isn't redirected)", async () => {
    expect((await get("/app/api/logout", { method: "POST" })).status).not.toBe(302);
  });
});

describe("Nova Agent's own address", () => {
  it("/nova-agent/* answers (with Nova Agent's key)", async () => {
    const res = await get("/nova-agent/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401); // no key: refused, but routed
  });
});
