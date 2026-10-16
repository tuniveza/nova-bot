// NovaBot's voice on the VPS (vps/voice/server.py): with VOICE_URL and VOICE_KEY set, /speak and
// /listen use the server's own voice service (a British voice; Whisper), with its key, and say so
// plainly when it's down. (On Cloudflare they use Workers AI, as before.)
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src";

const BASE = "https://novacane-worker.test";
const VOICE = { ...env, VOICE_URL: "http://127.0.0.1:8791", VOICE_KEY: "voice-test-key" };
let calls = [];
let up = true;

function fakeVoice() {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get("Authorization"), type: new Headers(init.headers).get("Content-Type") });
    if (!up) throw new Error("connection refused");
    if (String(url).endsWith("/speak")) return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), { headers: { "Content-Type": "audio/wav" } });
    if (String(url).endsWith("/listen")) return Response.json({ text: " How much is a session? " });
    return new Response("?", { status: 404 });
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  up = true;
});
async function call(path, init, e = VOICE) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { method: "POST", headers: { Origin: "https://novacane.co.uk", ...(init.headers || {}) }, body: init.body }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("NovaBot's voice on the VPS", () => {
  it("speaks with the server's own voice, with its key", async () => {
    fakeVoice();
    const res = await call("/speak", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hello from Novacane." }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");
    expect(calls).toEqual([{ url: "http://127.0.0.1:8791/speak", auth: "Bearer voice-test-key", type: "application/json" }]);
  });
  it("hears what was said with the server's Whisper", async () => {
    fakeVoice();
    const res = await call("/listen", { headers: { "Content-Type": "audio/wav" }, body: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "How much is a session?" });
    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:8791/listen", auth: "Bearer voice-test-key", type: "audio/wav" });
  });
  it("says so plainly when the voice service is down", async () => {
    up = false;
    fakeVoice();
    expect((await call("/speak", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hi" }) })).status).toBe(503);
    expect((await call("/listen", { headers: { "Content-Type": "audio/wav" }, body: new Uint8Array([1, 2, 3]) })).status).toBe(503);
  });
});
