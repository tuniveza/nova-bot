// The old standalone Notes and Calendar sites (nova-notes / nova-calendar .workers.dev), retired.
//
// Both apps keep everything in the browser, per site, so a plain redirect would strand what's
// saved there. Instead, opening the old address shows a page that looks in this browser:
//   nothing saved here → straight on to the new address (Nova Bot's /notes/ or /calendar/)
//   something saved    → "Download a backup", then open the new address and restore it there
//                        (Notes: ⋯ → Restore a backup…; Calendar: Import)
// Its old offline helper (/sw.js) is replaced by one that clears what it kept and steps aside,
// so a copy installed on a phone or computer stops showing the old version.
//
// One script for both sites; APP in each wrangler config says which (wrangler.notes.jsonc,
// wrangler.calendar.jsonc). Deploying them replaces the old Workers of the same name.

const NEW_SITE = "https://novacane-worker.novacane-studio.workers.dev";

const APPS = {
  notes: {
    name: "Notes",
    path: "/notes/",
    restore: "In Notes, open the ⋯ menu and choose <b>Restore a backup…</b>, then pick the file.",
    file: "Notes backup",
  },
  calendar: {
    name: "Calendar",
    path: "/calendar/",
    restore: "In Calendar, press <b>Import</b> and pick the file.",
    file: "nova-calendar-backup",
  },
};

const RETIRE_SW = `// This site has moved: clear the old offline copy, step aside, and reload the page.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) await caches.delete(key);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
})()));
`;

export default {
  async fetch(request, env) {
    const app = APPS[env.APP] || APPS.notes;
    const url = new URL(request.url);
    const target = NEW_SITE + app.path + url.pathname.replace(/^\/+/, "").replace(/^(index\.html)?$/, "") + url.search;

    if (url.pathname === "/sw.js") {
      return new Response(RETIRE_SW, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
    }
    // Pages get the move page (it has to run here to see what this browser saved for this site);
    // everything else (scripts, icons, the manifest) goes straight to its new address
    const page = request.method === "GET" && (request.headers.get("Sec-Fetch-Mode") === "navigate" || (request.headers.get("Accept") || "").includes("text/html"));
    if (!page) return Response.redirect(target, 301);
    return new Response(movePage(app, target), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      },
    });
  },
};

function movePage(app, target) {
  const cfg = JSON.stringify({ app: app === APPS.calendar ? "calendar" : "notes", target, file: app.file });
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${app.name} has moved</title>
<style>
  :root { color-scheme: dark; --hi: #FF5FA8; --accent: #B01D68; --accent-2: #7A1F86; --text: #EBD3E7; --muted: #B997B5; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: radial-gradient(120% 80% at 50% 0%, #2a1240, #06040D 70%); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(460px, 100%); padding: 28px 24px; border-radius: 24px; border: 1px solid rgba(255,95,168,.3); background: rgba(28,17,41,.85); text-align: center; }
  h1 { margin: 0 0 8px; font-size: 26px; color: #fff; }
  p { margin: 0 0 14px; color: var(--muted); }
  p b { color: var(--text); }
  .btn { display: block; width: 100%; margin: 10px 0 0; padding: 13px 16px; border-radius: 14px; border: 1px solid rgba(255,95,168,.35); background: transparent; color: var(--text); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .main { border: 0; color: #fff; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
  .done { color: var(--hi); font-weight: 600; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>${app.name} has moved</h1>
  <p id="looking">Checking what's saved in this browser…</p>
  <div id="has" hidden>
    <p>It's part of Nova Agent now. This browser still has <b id="count"></b> saved at this old address. Each address keeps its own, so bring them with you:</p>
    <button class="btn main" id="save" type="button">1. Download a backup</button>
    <p id="saved" class="done" hidden>Backup downloaded.</p>
    <a class="btn" id="go" href="${target}">2. Open ${app.name} at its new address</a>
    <p style="margin-top:14px">${app.restore}</p>
  </div>
</main>
<script>
(async () => {
  const C = ${cfg};
  const $ = (id) => document.getElementById(id);
  const ls = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } };
  async function idbNotes() {
    try {
      if (!indexedDB.databases || !(await indexedDB.databases()).some((d) => d.name === "nova-notes")) return [];
    } catch (e) {}
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open("nova-notes", 1);
        req.onupgradeneeded = () => { req.transaction.abort(); resolve([]); };
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("notes")) return resolve([]);
          const all = db.transaction("notes").objectStore("notes").getAll();
          all.onsuccess = () => resolve(all.result || []);
          all.onerror = () => resolve([]);
        };
      } catch (e) { resolve([]); }
    });
  }
  let backup = null, label = "";
  if (C.app === "notes") {
    const byId = new Map();
    for (const n of Object.values(ls("nova-notes/notes-v1") || {})) if (n && n.id) byId.set(n.id, n);
    for (const n of await idbNotes()) if (n && n.id) byId.set(n.id, n);
    const notes = [...byId.values()].filter((n) => typeof n.html === "string");
    if (notes.length) {
      backup = { app: "nova-notes", version: 1, exported: new Date().toISOString(), notes };
      label = notes.length === 1 ? "1 note" : notes.length + " notes";
    }
  } else {
    const data = ls("nova-calendar/v1") || ls("nova-task/v1");
    const days = (data && Array.isArray(data.days) ? data.days.length : 0), notes = (data && Array.isArray(data.notes) ? data.notes.length : 0);
    if (days + notes) {
      backup = data;
      label = [days && (days === 1 ? "1 day card" : days + " day cards"), notes && (notes === 1 ? "1 note card" : notes + " note cards")].filter(Boolean).join(" and ");
    }
  }
  // Nothing saved here: nothing to bring, so straight on
  if (!backup) return location.replace(C.target);
  $("looking").hidden = true;
  $("has").hidden = false;
  $("count").textContent = label;
  $("save").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    a.download = C.file + " " + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    $("saved").hidden = false;
  });
})();
</script>
</body>
</html>`;
}
