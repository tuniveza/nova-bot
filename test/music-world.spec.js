// Nova Agent's "Today in music" photos (src/music-world.js), against a pretend Wikipedia.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMusicWorld } from "../src/music-world.js";

const ctx = { waitUntil: () => {} };
const ask = (path) => handleMusicWorld(new Request(`https://bot.test${path}`), {}, ctx, path);

beforeEach(() => {
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
});
afterEach(() => vi.unstubAllGlobals());

describe("a musician's photo", () => {
  it("Wikipedia too slow to answer: a quiet 'no photo', with a time limit on every lookup", async () => {
    const signals = [];
    vi.stubGlobal("fetch", (url, init = {}) => {
      signals.push(init.signal);
      return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
    });
    const res = await ask("/music-world/photo/Nina_Simone");
    expect(res.status).toBe(404);
    expect(signals.length).toBeGreaterThan(0);
    signals.forEach((s) => expect(s).toBeInstanceOf(AbortSignal));
  });

  it("found: the picture itself", async () => {
    vi.stubGlobal("fetch", async (url) =>
      String(url).includes("/page/summary/")
        ? Response.json({ thumbnail: { source: "https://upload.wikimedia.org/a/Nina.jpg?x=1" } })
        : new Response("img", { headers: { "Content-Type": "image/jpeg" } })
    );
    const res = await ask("/music-world/photo/Nina_Simone");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });
});
