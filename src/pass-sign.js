// The switch-over to the VPS (vps/README.md): Cloudflare's address stays, and a thin pass-through
// Worker (src/passthrough.js) forwards every request to Nova Bot on the VPS. These are the keys the
// two share, all made from AGENT_NOVA_KEY (the same on both), so nothing new has to be copied:
//
//   - the pass key: signs who the visitor is (their IP address) and which address they asked for,
//     so the VPS can trust them (src/vps-front.js) and nobody else can pretend to be the pass-through
//   - the Acuity keys: the VPS's own webhook and email keys. Acuity (and the Google script that hands
//     over Acuity's emails) still use Cloudflare's old keys; the pass-through checks those and swaps
//     in the VPS's, so nothing has to change in Acuity
//
// HMAC-SHA256 with AGENT_NOVA_KEY as the key; hex out. The VPS's switch step works the same ones out
// with Node (vps/bin/switch-keys).

const enc = new TextEncoder();

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A key for one purpose, made from AGENT_NOVA_KEY ("" when there's no AGENT_NOVA_KEY)
export async function derivedKey(env, label) {
  if (!env.AGENT_NOVA_KEY) return "";
  return hmacHex(env.AGENT_NOVA_KEY, label);
}

// The pass-through's signature over when, who and which address
export async function passSignature(env, ts, ip, host) {
  const key = await derivedKey(env, "nova-pass-v1");
  if (!key) return "";
  return hmacHex(key, `${ts}\n${ip}\n${host}`);
}

// Same length, same time, whatever was sent
export function sameHex(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  let diff = x.length === y.length && x.length > 0 ? 0 : 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export const PASS_HEADERS = ["x-nova-pass-ts", "x-nova-pass-ip", "x-nova-pass-host", "x-nova-pass-sig"];
// How fresh a signature must be (the clocks on Cloudflare and the VPS are both kept right)
export const PASS_WINDOW_MS = 5 * 60 * 1000;
