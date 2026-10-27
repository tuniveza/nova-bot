// Nova Agent's "Today in music" (its front page): the live bits, fetched here and kept a while so
// it stays quick and light.
//   GET /music-world               { updated, source, top: [{ rank, title, artist, art, url, markets }], stale?, note? }
//     The ten songs most played right now across twelve big markets, from Apple Music's public
//     most-played charts, or the iTunes Store's top songs when Apple Music turns us away (each song
//     scores by its place in each market, added up). Kept 6 hours. When neither answers: the last
//     chart that loaded with stale: true, or 503 if none ever did.
//   GET /music-world/photo/<Wiki_Title>
//     A musician's photo (for the quote of the day): Wikipedia's picture for that page, as a
//     redirect to the image. Kept a week. 404 when there isn't one (the page shows initials).
//   GET /music-world/art?q=<artist and song>   album art (Apple's public music search)
const MARKETS = ["us", "gb", "br", "mx", "de", "fr", "jp", "kr", "in", "ng", "au", "es"];
const HOURS = 3600;
// An outside site slow to answer: give up and say "no picture" (well before Nova Agent stops
// waiting). One limit for the whole of each picture, lookup and download together, so the front
// page's pictures never keep Nova Agent's page loading for long
const WAIT = 8000;
// Apple's chart feed turns away requests that don't look like a browser
const BROWSER = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", Accept: "application/json" };

const json = (data, status = 200, maxAge = 6 * HOURS) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${Math.min(maxAge, HOURS)}, s-maxage=${maxAge}` },
  });

async function cached(request, ctx, make) {
  const cache = caches.default;
  const u = new URL(request.url);
  u.searchParams.set("v", "3"); // bump to forget what was kept before
  const key = new Request(u.toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

// The charts, best first. Apple Music's most-played feed (rss.marketingtools.apple.com) answers 403
// to every request carrying the "CF-Worker" header, which the Workers runtime (Cloudflare and the
// VPS's Miniflare alike) adds to every outside fetch and a worker can't remove (found 27 Oct 2026:
// the same request answers 200 from curl and 403 with that one header). So when it turns us away,
// the iTunes Store's top songs (itunes.apple.com, which doesn't) stand in.
const FEEDS = [
  {
    source: "Apple Music most played, 12 markets",
    url: (m) => `https://rss.marketingtools.apple.com/api/v2/${m}/music/most-played/25/songs.json`,
    songs: (d) => ((d && d.feed && d.feed.results) || []).map((s) => ({ id: s.id, title: s.name, artist: s.artistName, art: s.artworkUrl100, url: s.url })),
  },
  {
    source: "iTunes Store top songs, 12 markets",
    url: (m) => `https://itunes.apple.com/${m}/rss/topsongs/limit=25/json`,
    songs: (d) =>
      [].concat((d && d.feed && d.feed.entry) || []).map((e) => {
        const label = (x) => (x && x.label) || "";
        const images = e["im:image"] || [];
        const link = [].concat(e.link || []).find((l) => l && l.attributes && l.attributes.rel === "alternate");
        return {
          id: e.id && e.id.attributes && e.id.attributes["im:id"],
          title: label(e["im:name"]),
          artist: label(e["im:artist"]),
          art: label(images[images.length - 1]),
          url: (link && link.attributes.href) || label(e.id),
        };
      }),
  },
];
// A feed counts only when most markets answered (so one market never stands for the world)
const ENOUGH = Math.ceil(MARKETS.length / 2);

async function fromFeed(feed) {
  const lists = await Promise.all(
    MARKETS.map((m) =>
      fetch(feed.url(m), { headers: BROWSER, signal: AbortSignal.timeout(WAIT) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => feed.songs(d).filter((s) => s.title && s.artist))
        .catch(() => [])
    )
  );
  if (lists.filter((l) => l.length).length < ENOUGH) return [];
  const songs = new Map();
  lists.forEach((list) => {
    list.forEach((s, i) => {
      const key = s.id || `${s.artist}|${s.title}`.toLowerCase();
      const was = songs.get(key) || { title: s.title, artist: s.artist, art: s.art, url: s.url, score: 0, markets: 0 };
      was.score += 26 - (i + 1);
      was.markets += 1;
      songs.set(key, was);
    });
  });
  return [...songs.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ score, ...s }, i) => ({ rank: i + 1, ...s }));
}

async function topSongs() {
  for (const feed of FEEDS) {
    const top = await fromFeed(feed);
    if (top.length) return { top, source: feed.source };
  }
  return { top: [], source: "" };
}

// The last chart that loaded, kept a month: shown (marked as such) when no feed answers
const LAST = new Request("https://music-world.nova/last-good-chart", { method: "GET" });
async function keepLast(data) {
  try {
    await caches.default.put(LAST, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${30 * 24 * HOURS}` } }));
  } catch (err) {}
}
async function lastGood() {
  try {
    const hit = await caches.default.match(LAST);
    return hit ? await hit.json() : null;
  } catch (err) {
    return null;
  }
}

export async function handleMusicWorld(request, env, ctx, pathname) {
  if (request.method !== "GET") return json({ error: "Only GET" }, 405, 0);
  if (pathname === "/music-world") {
    return cached(request, ctx, async () => {
      const { top, source } = await topSongs();
      if (top.length) {
        const data = { updated: new Date().toISOString(), source, top };
        ctx.waitUntil(keepLast(data));
        return json(data);
      }
      // No feed answered: the last chart that loaded, marked as old and kept only 10 minutes so
      // the next look soon tries again; nothing at all only if none ever loaded (not kept)
      const last = await lastGood();
      if (last && last.top && last.top.length) return json({ ...last, stale: true, note: "Apple's charts can't be reached just now, so this is the last chart that loaded." }, 200, 600);
      return json({ updated: new Date().toISOString(), top: [], note: "Apple's charts can't be reached just now." }, 503, 0);
    });
  }
  const m = /^\/music-world\/photo\/([\w%().,'-]{1,120})$/.exec(pathname);
  if (m) {
    return cached(request, ctx, async () => {
      try {
        const signal = AbortSignal.timeout(WAIT);
        const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${m[1]}`, { headers: { "User-Agent": "NovaAgent/1.0 (Novacane Studios; music front page)" }, signal });
        const data = r.ok ? await r.json() : null;
        const src = data && data.thumbnail && data.thumbnail.source;
        // Served from here (not a link to Wikipedia's image server), so nothing in the browser
        // blocks it; without Wikipedia's tracking tags
        if (src && /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(src)) {
          const img = await fetch(src.split("?")[0], { headers: { "User-Agent": "NovaAgent/1.0 (Novacane Studios; music front page)" }, signal });
          if (img.ok && /^image\//.test(img.headers.get("Content-Type") || ""))
            return new Response(img.body, { headers: { "Content-Type": img.headers.get("Content-Type"), "Cache-Control": `public, max-age=${24 * HOURS}, s-maxage=${7 * 24 * HOURS}` } });
        }
      } catch (err) {}
      return new Response("No photo", { status: 404, headers: { "Cache-Control": `public, max-age=${HOURS}` } });
    });
  }
  // GET /music-world/file/<Commons file name>: one exact photo from Wikimedia Commons (a product
  // photo chosen by hand), served from here. Kept a week. 404 when it can't be had.
  const f = /^\/music-world\/file\/([^/]{1,160})$/.exec(pathname);
  if (f) {
    return cached(request, ctx, async () => {
      try {
        const name = decodeURIComponent(f[1]);
        if (!/^[\w .()'&,-]+\.(jpe?g|png|webp)$/i.test(name)) return new Response("Not a photo", { status: 400 });
        const img = await fetch(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=240`, { headers: { "User-Agent": "NovaAgent/1.0 (Novacane Studios; music front page)" }, signal: AbortSignal.timeout(WAIT) });
        if (img.ok && /^image\//.test(img.headers.get("Content-Type") || ""))
          return new Response(img.body, { headers: { "Content-Type": img.headers.get("Content-Type"), "Cache-Control": `public, max-age=${24 * HOURS}, s-maxage=${7 * 24 * HOURS}` } });
      } catch (err) {}
      return new Response("No photo", { status: 404, headers: { "Cache-Control": `public, max-age=${HOURS}` } });
    });
  }
  // GET /music-world/img?u=<an Apple Music cover address>: that exact cover, served from here (so
  // nothing in the browser blocks it). Only Apple's image servers. Kept a week.
  if (pathname === "/music-world/img") {
    const u = new URL(request.url).searchParams.get("u") || "";
    if (!/^https:\/\/is\d-ssl\.mzstatic\.com\/image\/thumb\/[\w/.,%-]+$/.test(u)) return new Response("Not a cover", { status: 400 });
    return cached(request, ctx, async () => {
      try {
        const img = await fetch(u, { signal: AbortSignal.timeout(WAIT) });
        if (img.ok && /^image\//.test(img.headers.get("Content-Type") || ""))
          return new Response(img.body, { headers: { "Content-Type": img.headers.get("Content-Type"), "Cache-Control": `public, max-age=${24 * HOURS}, s-maxage=${30 * 24 * HOURS}` } });
      } catch (err) {}
      return new Response("No cover", { status: 404, headers: { "Cache-Control": "public, max-age=600" } });
    });
  }
  // GET /music-world/art?q=<artist and song>: album art for a song (Apple's public music search),
  // as a redirect to the picture. Kept a week. 404 when nothing's found.
  if (pathname === "/music-world/art") {
    const q = (new URL(request.url).searchParams.get("q") || "").slice(0, 120);
    if (!q) return json({ error: "Say what to look for" }, 400, 0);
    return cached(request, ctx, async () => {
      try {
        const signal = AbortSignal.timeout(WAIT);
        const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=1`, { headers: BROWSER, signal });
        const data = r.ok ? await r.json() : null;
        const art = data && data.results && data.results[0] && data.results[0].artworkUrl100;
        if (art && /^https:\/\/[\w.-]+\.mzstatic\.com\//.test(art)) {
          const img = await fetch(art.replace(/100x100bb/, "200x200bb"), { signal });
          if (img.ok) return new Response(img.body, { headers: { "Content-Type": img.headers.get("Content-Type") || "image/jpeg", "Cache-Control": `public, max-age=${24 * HOURS}, s-maxage=${7 * 24 * HOURS}` } });
        }
      } catch (err) {}
      return new Response("No art", { status: 404, headers: { "Cache-Control": `public, max-age=${HOURS}` } });
    });
  }
  return json({ error: "Not found" }, 404, 0);
}
