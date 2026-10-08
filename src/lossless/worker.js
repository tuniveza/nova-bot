// Nova Lossless Audio — Worker entry.
//
// Routes:
//   /lossless/            static page (served from public/ by Workers Static Assets)
//   /lossless/ws?room=X   WebSocket → LosslessRoom Durable Object (signalling only, no audio)
//   /lossless/ice         STUN + TURN servers for one call (TURN needs the two secrets below)
//
// Nova Bot (novacane-worker) serves this too: its build copies this file and room.js in
// (scripts/sync-apps.mjs) and sends /lossless/ws and /lossless/ice here.
//
// TURN (Cloudflare Realtime) relays the call when the two devices can't reach
// each other directly: different networks, mobile carriers, strict firewalls.
// Set it up once: create a TURN key in the dashboard (Realtime → TURN), then
//   npx wrangler secret put TURN_KEY_ID
//   npx wrangler secret put TURN_KEY_API_TOKEN
// The key never reaches the browser; each call gets short-lived credentials.
//
// To fold this into the existing Nova Worker, copy the /lossless/ws branch into
// its fetch handler, re-export LosslessRoom, and add the binding + migration
// from wrangler.toml.

export { LosslessRoom } from "./room.js";

const ROOM_RE = /^[a-z0-9-]{1,64}$/;
// Nova Agent on the studio PC (and its preview port)
const NOVA_AGENT = /^http:\/\/(localhost|127\.0\.0\.1):454[5-9]$/;

// Without TURN: STUN only, which connects most home networks but not all
const STUN_ONLY = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
// How long a call's TURN credentials last. The page fetches fresh ones before they run out.
const TURN_TTL = 6 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/lossless/ice") {
      return iceServers(request, env);
    }

    if (url.pathname === "/lossless/ws") {
      const room = (url.searchParams.get("room") || "").toLowerCase();
      if (!ROOM_RE.test(room)) {
        return new Response("Bad room code", { status: 400 });
      }
      const stub = env.LOSSLESS_ROOMS.get(env.LOSSLESS_ROOMS.idFromName(room));
      return stub.fetch(request);
    }

    // Standalone deploy only: send the bare domain to the demo page.
    if (url.pathname === "/") {
      return Response.redirect(new URL("/lossless/", url).toString(), 302);
    }

    return env.ASSETS.fetch(request);
  },
};

// Short-lived TURN credentials, from the TURN key kept in the Worker's secrets
async function iceServers(request, env) {
  const headers = { "Cache-Control": "no-store" };
  // Only this page asks: other sites can't use our relay. The one exception is the same page
  // served by Nova Agent on the studio PC, which uses this Worker for signalling and the relay.
  const origin = request.headers.get("Origin") || "";
  if (NOVA_AGENT.test(origin)) Object.assign(headers, { "Access-Control-Allow-Origin": origin, Vary: "Origin" });
  else {
    const site = request.headers.get("Sec-Fetch-Site");
    if (site && site !== "same-origin") return new Response("Forbidden", { status: 403, headers });
  }

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return Response.json({ iceServers: STUN_ONLY, turn: false, ttl: 0, note: "TURN isn't set up (see src/worker.js)" }, { headers });
  }
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL }),
    });
    if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
    const { iceServers } = await res.json();
    // Browsers block port 53, and ICE would wait for it to time out
    const cleaned = iceServers
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    return Response.json({ iceServers: cleaned, turn: true, ttl: TURN_TTL }, { headers });
  } catch (err) {
    console.error("TURN credentials:", err.message);
    return Response.json({ iceServers: STUN_ONLY, turn: false, ttl: 0, note: `TURN unavailable: ${err.message}` }, { headers });
  }
}
