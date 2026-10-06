// The master list of Nova suite links: every live address, every test and
// development address, the code, and the accounts behind it all.
//
// The list itself is kept in the database (settings: "url_directory"), never
// in this code, because the code is public on GitHub. It's shown only behind
// the admin password: on the admin page (/admin/links) and in Nova Hub. Each
// time it's opened, every web address is checked, so you can see at a glance
// what's up.
//
// Shape: { groups: [{ title, note?, items: [{ name, url, kind, note? }] }] }
// kind: "live" (in use), "machine" (used by apps, not people), "testing",
//       "local" (only on the studio computer), "planned" (not set up yet)

const KEY = "url_directory";
const KINDS = ["live", "machine", "testing", "local", "planned"];

export async function readLinks(env) {
  try {
    const value = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first("value");
    return cleanLinks(JSON.parse(value || "{}"));
  } catch {
    return { groups: [] };
  }
}

// Keep only the expected shape (and plain web addresses)
export function cleanLinks(raw) {
  const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const groups = (Array.isArray(raw?.groups) ? raw.groups : []).slice(0, 40).map((g) => ({
    title: text(g?.title, 80) || "Links",
    note: text(g?.note, 300),
    items: (Array.isArray(g?.items) ? g.items : [])
      .slice(0, 80)
      .map((i) => ({ name: text(i?.name, 120), url: text(i?.url, 600), kind: KINDS.includes(i?.kind) ? i.kind : "live", note: text(i?.note, 300) }))
      .filter((i) => i.name && /^(https?:\/\/|wrangler |npm |npx )/.test(i.url)),
  }));
  return { groups };
}

export async function saveLinks(env, raw) {
  const clean = cleanLinks(raw);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(KEY, JSON.stringify(clean)).run();
  return clean;
}

// Check one address: does it answer? (Addresses on the studio computer can't be checked from here.)
async function check(url, kind) {
  // Not set up yet: nothing to check
  if (kind === "planned") return { state: "unchecked", label: "Not set up yet" };
  if (!/^https:\/\//.test(url)) return { state: "unchecked", label: /localhost|127\.0\.0\.1/.test(url) ? "Studio computer only" : "Not a web address" };
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Nova Hub link check" } });
    const s = res.status;
    if (s >= 200 && s < 300) return { state: "up", label: `Up · ${s}` };
    if (s >= 300 && s < 400) return { state: "up", label: `Up · redirects (${s})` };
    if (s === 401 || s === 403) return { state: "up", label: `Up · password protected (${s})` };
    if (s === 405) return { state: "up", label: "Up · only accepts posts" };
    // It answered, but wants details it wasn't given (normal for addresses the apps use)
    if (s === 400) return { state: "up", label: "Up · needs details (400)" };
    if (s === 404) return { state: "down", label: "Not found (404)" };
    return { state: "down", label: `Problem (${s})` };
  } catch {
    return { state: "down", label: "No answer" };
  }
}

// The list with a live check of every address
export async function checkedLinks(env) {
  const list = await readLinks(env);
  const groups = await Promise.all(list.groups.map(async (g) => ({ ...g, items: await Promise.all(g.items.map(async (i) => ({ ...i, check: await check(i.url, i.kind) }))) })));
  return { groups, checkedAt: new Date().toISOString() };
}
