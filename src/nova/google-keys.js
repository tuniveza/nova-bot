// Google's keys for Nova Agent: the OAuth client (its ID and secret) and the studio's
// connection (the refresh token "Connect Google" brings back).
//
// They're set up inside the app (Admin → Google, see admin-google.js), so nobody has to run
// wrangler: the client ID is kept in the settings table as it is (it isn't secret: every
// browser sees it), and the client secret and refresh token are kept encrypted (AES-GCM, with
// a key derived from the AGENT_NOVA_KEY secret, so a copy of the database alone can't use them).
// Secrets set the old way (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) still win.

const ID_KEY = "google_client_id";
const SECRET_KEY = "google_client_secret_enc";
const REFRESH_KEY = "google_refresh_token_enc";
const OLD_REFRESH_KEY = "google_refresh_token"; // kept as plain text before Admin → Google existed

// ===== ENCRYPTION =====

const enc = new TextEncoder();
const keyCache = new Map();

async function cryptoKey(env) {
  const base = env.AGENT_NOVA_KEY;
  if (!base) throw new Error("Nova Bot can't keep Google's secret safely: its AGENT_NOVA_KEY secret isn't set.");
  if (keyCache.has(base)) return keyCache.get(base);
  const raw = await crypto.subtle.importKey("raw", enc.encode(base), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("nova-agent/google"), info: enc.encode("google-keys-v1") },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  keyCache.set(base, key);
  return key;
}

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), enc.encode(text)));
  return "v1." + toB64(iv) + "." + toB64(box);
}

export async function unseal(env, sealed) {
  const [v, iv, box] = String(sealed || "").split(".");
  if (v !== "v1" || !iv || !box) return "";
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await cryptoKey(env), fromB64(box));
    return new TextDecoder().decode(plain);
  } catch {
    return ""; // a different AGENT_NOVA_KEY, or tampered with: as good as not set
  }
}

// ===== SETTINGS =====

const read = (env, key) => env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value").catch(() => null);
const write = (env, key, value) =>
  env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value);

// ===== THE OAUTH CLIENT =====

// { id, secret, from: "secrets" | "app" | "" }. Every Google feature asks here.
export async function googleClient(env) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, from: "secrets" };
  if (!env.DB) return { id: "", secret: "", from: "" };
  const [id, sealed] = await Promise.all([read(env, ID_KEY), read(env, SECRET_KEY)]);
  const secret = sealed ? await unseal(env, sealed).catch(() => "") : "";
  return id && secret ? { id, secret, from: "app" } : { id: "", secret: "", from: "" };
}

// Just the client ID (public: the sign-in button and Notes' Google Docs use it in the browser)
export async function googleClientId(env) {
  return (await googleClient(env)).id;
}

// The pasted values look like a Google OAuth client? ("" if fine, otherwise what's wrong)
export function clientProblem(id, secret) {
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) return "That Client ID doesn't look right. It ends in .apps.googleusercontent.com.";
  if (!/^[\w-]{20,}$/.test(secret)) return "That Client secret doesn't look right. Copy it again from Google (it often starts with GOCSPX-).";
  return "";
}

export async function saveClient(env, id, secret) {
  await env.DB.batch([write(env, ID_KEY, id), write(env, SECRET_KEY, await seal(env, secret))]);
}

export async function removeClient(env) {
  await env.DB.prepare(`DELETE FROM settings WHERE key IN ('${ID_KEY}', '${SECRET_KEY}')`).run();
}

// ===== THE STUDIO'S CONNECTION =====

export async function refreshToken(env) {
  if (env.GOOGLE_REFRESH_TOKEN) return env.GOOGLE_REFRESH_TOKEN;
  if (!env.DB) return "";
  const sealed = await read(env, REFRESH_KEY);
  if (sealed) return (await unseal(env, sealed).catch(() => "")) || "";
  return (await read(env, OLD_REFRESH_KEY)) || "";
}

// A statement that keeps the refresh token (encrypted), for a batch; the plain old copy goes
export async function keepRefreshToken(env, token) {
  return [write(env, REFRESH_KEY, await seal(env, token)), env.DB.prepare(`DELETE FROM settings WHERE key = '${OLD_REFRESH_KEY}'`)];
}

export const REFRESH_KEYS = [REFRESH_KEY, OLD_REFRESH_KEY];
