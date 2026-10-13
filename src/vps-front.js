// Nova Bot on the VPS (DESK_HOST = "vps"): how each request is seen before anything else handles it.
//
// The runtime on the VPS (workerd, behind Caddy) is reached over plain http on 127.0.0.1, so it would
// see every address as http://… — but people reach it over https, and the "only from this site's own
// pages" checks compare the browser's Origin (https://…) with it. So the address is always https, and
// so is the browser's Origin for it (the runtime's proxy turns that into http://… on the way in).
//
// After the switch-over, requests arrive from the pass-through on Cloudflare (src/passthrough.js),
// signed: when, the visitor's IP address, and the address they asked for (the workers.dev one). When
// the signature is right and fresh, Nova Bot sees the request exactly as Cloudflare did: that address
// (so sign-ins, Google's return address, links and the Origin checks all line up) and that visitor
// (CF-Connecting-IP, which the rate limits and the IP fingerprints use). Unsigned or wrongly signed
// requests keep Caddy's own CF-Connecting-IP (the real caller) and the VPS's address. The signature
// headers never reach the rest of Nova Bot.

import { PASS_HEADERS, PASS_WINDOW_MS, passSignature, sameHex } from "./pass-sign.js";

// The addresses the pass-through is allowed to stand in for: PUBLIC_URL, and the old address
// (OLD_PUBLIC_HOSTS, comma-separated) while old links, bookmarks and phone apps are moved over
function publicHosts(env) {
  const hosts = String(env.OLD_PUBLIC_HOSTS ?? "novacane-worker.novacane-studio.workers.dev").split(",").map((h) => h.trim()).filter(Boolean);
  try {
    hosts.push(new URL(String(env.PUBLIC_URL || "")).host);
  } catch {}
  return hosts;
}

export async function vpsFront(request, env, now = Date.now()) {
  if (env.DESK_HOST !== "vps") return request;
  const url = new URL(request.url);
  url.protocol = "https:";
  // (the runtime is reached on 127.0.0.1:8787; people use the address on its own)
  if (url.port === "8787") url.port = "";
  const headers = new Headers(request.headers);
  const ts = headers.get("x-nova-pass-ts");
  const ip = headers.get("x-nova-pass-ip") || "";
  const host = headers.get("x-nova-pass-host") || "";
  const sig = headers.get("x-nova-pass-sig");
  for (const h of PASS_HEADERS) headers.delete(h);
  // The local runtime's own proxy (wrangler dev) rewrites a browser's Origin for this address,
  // https://<this address>, to http://<this address> (its own plain-http side). Put it back, the
  // same way as the address itself, or every "only from this site's own pages" check says no.
  // (No page is ever served over plain http here: Caddy sends http to https.)
  const origin = headers.get("Origin");
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.protocol === "http:" && o.hostname === url.hostname && (o.port === "" || o.port === "8787")) headers.set("Origin", `https://${url.host}`);
    } catch {}
  }
  if (ts && sig && host && publicHosts(env).includes(host) && Math.abs(now - Number(ts)) <= PASS_WINDOW_MS) {
    if (sameHex(sig, await passSignature(env, ts, ip, host))) {
      url.host = host;
      if (!host.includes(":")) url.port = "";
      if (ip) headers.set("CF-Connecting-IP", ip);
      else headers.delete("CF-Connecting-IP");
    }
  }
  if (url.toString() === request.url && !PASS_HEADERS.some((h) => request.headers.has(h)) && headers.get("Origin") === request.headers.get("Origin")) return request;
  return new Request(url.toString(), new Request(request, { headers }));
}
