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

describe("the Top 10 worldwide", () => {
  const appleMusic = (n) => ({ feed: { results: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Song ${i}`, artistName: `Artist ${i}`, artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/a/${i}/100x100bb.jpg`, url: `https://music.apple.com/s${i}` })) } });
  const itunes = (n) => ({
    feed: {
      entry: Array.from({ length: n }, (_, i) => ({
        "im:name": { label: `Hit ${i}` },
        "im:artist": { label: `Singer ${i}` },
        "im:image": [{ label: "https://is1-ssl.mzstatic.com/image/thumb/b/55x55bb.png" }, { label: `https://is1-ssl.mzstatic.com/image/thumb/b/${i}/170x170bb.png` }],
        id: { label: `https://music.apple.com/gb/album/x?i=${i}`, attributes: { "im:id": `h${i}` } },
        link: [{ attributes: { rel: "alternate", href: `https://music.apple.com/gb/album/hit-${i}` } }],
      })),
    },
  });
  const turnedAway = () => new Response("<h1>403 Forbidden</h1>", { status: 403 });
  // A Cache API that really keeps things (for the last chart that loaded)
  const realCache = () => {
    const kept = new Map();
    vi.stubGlobal("caches", { default: { match: async (r) => kept.get(r.url)?.clone(), put: async (r, res) => void kept.set(r.url, res.clone()) } });
  };
  const waits = [];
  const ctxKeep = { waitUntil: (p) => waits.push(p) };
  const askTop = () => handleMusicWorld(new Request("https://bot.test/music-world"), {}, ctxKeep, "/music-world");

  it("Apple Music answers: its most-played chart, with a time limit on every market", async () => {
    const signals = [];
    vi.stubGlobal("fetch", async (url, init = {}) => {
      signals.push(init.signal);
      return String(url).includes("rss.marketingtools.apple.com") ? Response.json(appleMusic(25)) : turnedAway();
    });
    const res = await askTop();
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.source).toMatch(/Apple Music/);
    expect(d.top).toHaveLength(10);
    expect(d.top[0]).toMatchObject({ rank: 1, title: "Song 0", artist: "Artist 0", markets: 12 });
    expect(signals).toHaveLength(12);
    signals.forEach((s) => expect(s).toBeInstanceOf(AbortSignal));
  });

  it("Apple Music turns the worker away (403, as it does to every CF-Worker request): the iTunes Store's top songs instead", async () => {
    vi.stubGlobal("fetch", async (url) => (String(url).includes("itunes.apple.com/") ? Response.json(itunes(25)) : turnedAway()));
    const res = await askTop();
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.source).toMatch(/iTunes/);
    expect(d.top).toHaveLength(10);
    expect(d.top[0]).toMatchObject({ rank: 1, title: "Hit 0", artist: "Singer 0", url: "https://music.apple.com/gb/album/hit-0" });
    expect(d.top[0].art).toBe("https://is1-ssl.mzstatic.com/image/thumb/b/0/170x170bb.png");
  });

  it("only a few markets answer: never one country passed off as the world", async () => {
    vi.stubGlobal("fetch", async (url) => (/\/(us|gb)\//.test(String(url)) ? Response.json(String(url).includes("itunes") ? itunes(25) : appleMusic(25)) : turnedAway()));
    const res = await askTop();
    expect(res.status).toBe(503);
  });

  it("nothing answers: the last chart that loaded, marked as old (and kept only a short while)", async () => {
    realCache();
    vi.stubGlobal("fetch", async (url) => (String(url).includes("itunes.apple.com/") ? Response.json(itunes(25)) : turnedAway()));
    await (await askTop()).json();
    await Promise.all(waits);
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    // (a fresh look: the chart's own 6-hour copy is under a different key, so empty it)
    const res = await handleMusicWorld(new Request("https://bot.test/music-world?fresh=1"), {}, ctxKeep, "/music-world");
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.stale).toBe(true);
    expect(d.note).toMatch(/last chart/);
    expect(d.top[0].title).toBe("Hit 0");
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600");
  });

  it("nothing answers and no chart ever loaded: 503 with a plain note", async () => {
    vi.stubGlobal("fetch", async () => turnedAway());
    const res = await askTop();
    expect(res.status).toBe(503);
    expect((await res.json()).note).toMatch(/can't be reached/);
  });
});
