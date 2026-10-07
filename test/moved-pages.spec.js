// Nova Agent's panels online keep their own addresses: Hub at /app/, Portal at
// /portal/, Index at /app/memory/. The addresses they had for a day go back there.
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
    ["/studio/", "/app/"],
    ["/studio/#nova", "/app/#nova"],
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

describe("Nova Agent's own address", () => {
  it("/nova-agent/* answers like /hub/agent/* (with Nova Agent's key)", async () => {
    const res = await get("/nova-agent/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401); // no key: refused, but routed
    const old = await get("/hub/agent/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(old.status).toBe(401);
  });
});
