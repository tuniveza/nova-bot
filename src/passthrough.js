// The switch-over to the VPS (vps/README.md): Cloudflare keeps the address everyone uses
// (novacane-worker.novacane-studio.workers.dev), but this tiny Worker stands in for Nova Bot and
// passes every request on to Nova Bot on the VPS, as it is: pages, the staff API, the website chat,
// streams (Nova Agent's live feeds), and WebSockets (the studio PC's link, Lossless audio).
//
// Deployed in place of the normal Worker with `wrangler deploy -c wrangler.passthrough.jsonc`
// (vps/switch.sh); the normal `wrangler deploy` puts Nova Bot back (vps/switch-back.sh). It has no
// timed jobs (those run on the VPS), uses no database, and keeps no state of its own. The Durable
// Object classes are still exported (unused) so Cloudflare keeps their saved state for a switch back.
//
// Each request is signed for the VPS (src/pass-sign.js, src/vps-front.js): when, the visitor's IP
// address and the address they asked for, so Nova Bot on the VPS sees the request as Cloudflare
// did. Acuity's webhook key and the Google script's email key are Cloudflare's old ones: checked here
// and swapped for the VPS's own (made from AGENT_NOVA_KEY), so nothing changes in Acuity.
// The VPS can't be reached (restarting, or down): a calm page, or JSON for the apps.

import { PASS_HEADERS, derivedKey, passSignature, sameHex } from "./pass-sign.js";

export { LosslessRoom } from "./lossless/room.js";
export { AgentLink } from "./agent-relay.js";

const DEFAULT_VPS = "https://185-185-126-195.sslip.io";

const restarting = (request) => {
  const wantsPage = (request.headers.get("Accept") || "").includes("text/html");
  const headers = { "Cache-Control": "no-store", "Retry-After": "30" };
  if (wantsPage) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nova is restarting</title><meta http-equiv="refresh" content="30">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#100816;color:#EBD3E7;font:16px/1.6 system-ui,sans-serif;padding:24px;text-align:center"><main><h1 style="color:#fff;font-size:22px;font-weight:600">Nova is restarting</h1><p>Try again in a minute. This page refreshes by itself.</p></main>`,
      { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  return Response.json({ error: "Nova is restarting, try again in a minute", restarting: true }, { status: 503, headers });
};

// The address on the VPS for this request, with Acuity's webhook key swapped for the VPS's
async function target(request, env) {
  const url = new URL(request.url);
  const to = new URL(url.pathname + url.search, String(env.VPS_ORIGIN || DEFAULT_VPS));
  if (url.pathname === "/acuity/webhook" && env.ACUITY_WEBHOOK_KEY && sameHex(to.searchParams.get("key"), env.ACUITY_WEBHOOK_KEY)) {
    to.searchParams.set("key", await derivedKey(env, "acuity-webhook-v1"));
  }
  return { url, to };
}

export async function passOn(request, env, now = Date.now()) {
  const { url, to } = await target(request, env);
  const headers = new Headers(request.headers);
  // Nobody outside can send these: only this Worker signs
  for (const h of PASS_HEADERS) headers.delete(h);
  if (url.pathname === "/acuity/email" && env.ACUITY_EMAIL_KEY && sameHex(headers.get("X-Nova-Key"), env.ACUITY_EMAIL_KEY)) {
    headers.set("X-Nova-Key", await derivedKey(env, "acuity-email-v1"));
  }
  const ts = String(now);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  headers.set("X-Nova-Pass-Ts", ts);
  headers.set("X-Nova-Pass-Ip", ip);
  headers.set("X-Nova-Pass-Host", url.host);
  headers.set("X-Nova-Pass-Sig", await passSignature(env, ts, ip, url.host));
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let res;
  try {
    res = await fetch(to.toString(), { method: request.method, headers, body: hasBody ? request.body : null, redirect: "manual" });
  } catch {
    return restarting(request);
  }
  // Caddy on the VPS answers 502/504 (with no body type) when Nova Bot itself isn't up
  // (restarting); Nova Bot's own 502s (e.g. "the studio computer couldn't answer") are JSON and pass
  if ((res.status === 502 || res.status === 504) && !res.headers.get("Content-Type")) return restarting(request);
  return res;
}

export default {
  fetch(request, env) {
    return passOn(request, env);
  },
};
