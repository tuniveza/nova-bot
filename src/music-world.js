// Nova Agent's "Today in music" (its front page): the live bits, fetched here and kept a while so
// it stays quick and light.
//   GET /music-world               { updated, top: [{ rank, title, artist, art, url, markets }] }
//     The ten songs most played right now across twelve big markets, from Apple Music's public
//     most-played charts (each song scores by its place in each market, added up). Kept 6 hours.
//   GET /music-world/photo/<Wiki_Title>
//     A musician's photo (for the quote of the day): Wikipedia's picture for that page, as a
//     redirect to the image. Kept a week. 404 when there isn't one (the page shows initials).
const MARKETS = ["us", "gb", "br", "mx", "de", "fr", "jp", "kr", "in", "ng", "au", "es"];
const HOURS = 3600;

const json = (data, status = 200, maxAge = 6 * HOURS) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${Math.min(maxAge, HOURS)}, s-maxage=${maxAge}` },
  });

async function cached(request, ctx, make) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok || res.status === 302) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

async function topSongs() {
  const lists = await Promise.all(
    MARKETS.map((m) =>
      fetch(`https://rss.applemarketingtools.com/api/v2/${m}/music/most-played/25/songs.json`, { cf: { cacheTtl: 6 * HOURS, cacheEverything: true } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    )
  );
  const songs = new Map();
  lists.forEach((list) => {
    const results = (list && list.feed && list.feed.results) || [];
    results.forEach((s, i) => {
      const key = s.id || `${s.artistName}|${s.name}`.toLowerCase();
      const was = songs.get(key) || { title: s.name, artist: s.artistName, art: s.artworkUrl100, url: s.url, score: 0, markets: 0 };
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

export async function handleMusicWorld(request, env, ctx, pathname) {
  if (request.method !== "GET") return json({ error: "Only GET" }, 405, 0);
  if (pathname === "/music-world") {
    return cached(request, ctx, async () => {
      const top = await topSongs();
      if (!top.length) return json({ updated: new Date().toISOString(), top: [], note: "The charts couldn't be reached just now." }, 200, 600);
      return json({ updated: new Date().toISOString(), source: "Apple Music most played, 12 markets", top });
    });
  }
  const m = /^\/music-world\/photo\/([\w%().,'-]{1,120})$/.exec(pathname);
  if (m) {
    return cached(request, ctx, async () => {
      try {
        const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${m[1]}`, { headers: { "User-Agent": "NovaAgent/1.0 (Novacane Studios; music front page)" } });
        const data = r.ok ? await r.json() : null;
        const src = data && data.thumbnail && data.thumbnail.source;
        if (src && /^https:\/\/upload\.wikimedia\.org\//.test(src))
          return new Response(null, { status: 302, headers: { Location: src, "Cache-Control": `public, max-age=${24 * HOURS}, s-maxage=${7 * 24 * HOURS}` } });
      } catch (err) {}
      return new Response("No photo", { status: 404, headers: { "Cache-Control": `public, max-age=${HOURS}` } });
    });
  }
  return json({ error: "Not found" }, 404, 0);
}
