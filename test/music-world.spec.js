// Nova Agent's "Today in music" photos (src/music-world.js), against a pretend Wikipedia.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMusicWorld } from "../src/music-world.js";

const ctx = { waitUntil: () => {} };
const ask = (path) => handleMusicWorld(new Request(`https://bot.test${path}`), {}, ctx, path.split("?")[0]);

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

  it("one time limit for the lookup and the picture together (never two waits back to back)", async () => {
    const signals = [];
    vi.stubGlobal("fetch", async (url, init = {}) => {
      signals.push(init.signal);
      return String(url).includes("/page/summary/")
        ? Response.json({ thumbnail: { source: "https://upload.wikimedia.org/a/Nina.jpg" } })
        : new Response("img", { headers: { "Content-Type": "image/jpeg" } });
    });
    await ask("/music-world/photo/Nina_Simone");
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
  });
});

describe("covers and album art: a time limit, so a slow Apple never keeps the page loading", () => {
  it("a cover too slow: a quiet 'no cover'", async () => {
    const signals = [];
    vi.stubGlobal("fetch", (url, init = {}) => {
      signals.push(init.signal);
      return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
    });
    const res = await ask(`/music-world/img?u=${encodeURIComponent("https://is1-ssl.mzstatic.com/image/thumb/a/b.jpg/300x300bb.jpg")}`);
    expect(res.status).toBe(404);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("album art: one time limit for the search and the picture together", async () => {
    const signals = [];
    vi.stubGlobal("fetch", async (url, init = {}) => {
      signals.push(init.signal);
      return String(url).includes("itunes.apple.com/search")
        ? Response.json({ results: [{ artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg" }] })
        : new Response("img", { headers: { "Content-Type": "image/jpeg" } });
    });
    const res = await ask("/music-world/art?q=Nina%20Simone");
    expect(res.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
  });
});
