// Lossless audio and Observatory, online with the other panels.
// Lossless: signalling (/lossless/ws) and the relay setup (/lossless/ice) answer here.
// Observatory: its projects and media are for signed-in staff only.
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

describe("Lossless audio", () => {
  it("gives STUN servers when TURN isn't set up", async () => {
    const res = await get("/lossless/ice", { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.turn).toBe(false);
    expect(body.iceServers[0].urls.some((u) => u.startsWith("stun:"))).toBe(true);
  });

  it("other websites can't use the relay setup", async () => {
    const res = await get("/lossless/ice", { headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://elsewhere.example" } });
    expect(res.status).toBe(403);
  });

  it("Nova Agent's own page on the studio PC can", async () => {
    const res = await get("/lossless/ice", { headers: { "Sec-Fetch-Site": "cross-site", Origin: "http://localhost:4545" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4545");
  });

  it("signalling needs a room code and a WebSocket", async () => {
    expect((await get("/lossless/ws?room=BAD%20CODE")).status).toBe(400);
    expect((await get("/lossless/ws?room=test-room")).status).toBe(426);
  });

  it("two devices join a room", async () => {
    const open = async (client) => {
      const res = await get(`/lossless/ws?room=pair-test&client=${client}`, { headers: { Upgrade: "websocket" } });
      expect(res.status).toBe(101);
      res.webSocket.accept();
      return res.webSocket;
    };
    const a = await open("a");
    const seen = new Promise((resolve) => a.addEventListener("message", (e) => resolve(JSON.parse(e.data))));
    const b = await open("b");
    const first = await seen;
    expect(typeof first.type).toBe("string");
    a.close();
    b.close();
  });
});

describe("Observatory", () => {
  it("signed out, the projects ask for a sign-in", async () => {
    const res = await get("/observatory/data/projects.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OBSERVATORY_LOCKED");
    expect((await get("/observatory/media/anything/video.mp4")).status).toBe(401);
    expect((await get("/observatory/data/projects.json")).status).toBe(401);
  });

  it("signed in, they come from the panel's files", async () => {
    const res = await get("/observatory/data/projects.js", { headers: STAFF_AUTH });
    // The scan may not exist in a fresh checkout; either way it isn't the lock
    expect(await res.text()).not.toContain("OBSERVATORY_LOCKED");
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
  });
});
