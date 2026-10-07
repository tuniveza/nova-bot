// Nova Hub, Nova Portal and Nova Index moved into Nova Agent's panels (Studio, Crew, Index).
// Old links, bookmarks and installed phones keep working.  Run: npm test
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

describe("old addresses", () => {
  it.each([
    ["/app/", "/studio/"],
    ["/app", "/studio/"],
    ["/app/#nova", "/studio/#nova"],
    ["/app/memory/", "/index/"],
    ["/app/memory/?scope=studio", "/index/?scope=studio"],
    ["/portal/", "/crew/"],
    ["/portal/?invite=abc", "/crew/?invite=abc"],
  ])("%s goes to %s", async (from, to) => {
    const res = await get(from);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(BASE + to);
  });

  it("phones installed from /app/ keep their push helper (now Studio's)", async () => {
    const res = await get("/app/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/javascript/);
    expect(await res.text()).toMatch(/addEventListener\("push"/);
  });

  it("the staff API keeps its address", async () => {
    const res = await get("/app/api/me");
    expect(res.status).not.toBe(302);
  });
});

describe("Nova Agent's own address", () => {
  it("/nova-agent/* answers like /hub/agent/* (with Nova Agent's key)", async () => {
    const res = await get("/nova-agent/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401); // no key: refused, but routed
    const old = await get("/hub/agent/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(old.status).toBe(401);
  });
});
