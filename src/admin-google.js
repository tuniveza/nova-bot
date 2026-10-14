// Admin → Google: setting Google up from inside Nova Agent, one step at a time.
//
// Google makes a person click through Google Cloud once to make the "key" (an OAuth client);
// nothing can do that for them. So this page walks through it a step at a time: one sentence,
// a button that opens the right Google page, and copy buttons for exactly what to paste. Then
// the key is pasted here (kept by google-keys.js, the secret encrypted) and "Connect Google"
// links the studio's Google account (Calendar, Gmail, Docs). Google is a connection, never a
// way to sign in: Portal is the one sign-in.

import { escapeHtml } from "./referrals.js";
import { clientProblem, googleClient, keyProblemWithGoogle, removeClient, saveClient } from "./nova/google-keys.js";
import { connectedAccount, googleProblem, offline } from "./nova/google.js";

const e = escapeHtml;
const PC_ORIGIN = "http://localhost:4545";

export async function googleSetupPage(env, url, page) {
  const client = await googleClient(env);
  const account = client.id ? await connectedAccount(env) : "";
  const problem = client.id && account ? await googleProblem(env) : "";
  const origin = url.origin;
  const copy = (value) => `<div class="copy-row"><code>${e(value)}</code><button type="button" class="btn ghost small" data-copy="${e(value)}">Copy</button></div>`;
  const open = (href, label) => `<a class="btn" href="${e(href)}" target="_blank" rel="noopener">${e(label)} ↗</a>`;

  const status = offline(env)
    ? "Sandbox: Google is stood in for (no keys needed here)."
    : !client.id
      ? "Not set up yet. It takes about 5 minutes, one step at a time."
      : account
        ? problem
          ? `Set up ✓ · Connected as ${account}, but: ${problem}`
          : `All done ✓ · Connected as ${account}`
        : "Key saved ✓ · One step left: Connect Google.";

  const steps = [
    {
      title: "Switch on Google's features",
      body: `<p>Press the button, pick (or make) a project called <b>Nova Agent</b>, then press <b>Next</b> and <b>Enable</b>.</p>
        <p>${open("https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com,gmail.googleapis.com,drive.googleapis.com,people.googleapis.com,sheets.googleapis.com,docs.googleapis.com,tasks.googleapis.com,youtube.googleapis.com", "Open Google Cloud")}</p>`,
    },
    {
      title: "Set up Google's permission screen",
      body: `<p>Press <b>Get started</b>. App name: <b>Nova Agent</b>. Pick your own email for both email boxes. Audience: <b>External</b>. Then <b>Create</b>.</p>
        ${copy("Nova Agent")}
        <p>${open("https://console.cloud.google.com/auth/overview", "Open the sign-in screen")}</p>`,
    },
    {
      title: "Keep it working",
      body: `<p>Press <b>Publish app</b>, then <b>Confirm</b>. (If you skip this, Google stops the connection every 7 days.)</p>
        <p>${open("https://console.cloud.google.com/auth/audience", "Open Audience")}</p>`,
    },
    {
      title: "Make the key",
      body: `<p>Type: <b>Web application</b>. Name: <b>Nova Agent</b>. Add these, then press <b>Create</b>.</p>
        <p class="dim small">Authorised JavaScript origins (+ Add URI):</p>
        ${copy(origin)}
        <p class="dim small">Authorised redirect URI (+ Add URI):</p>
        ${copy(origin + "/admin/google/callback")}
        <p>${open("https://console.cloud.google.com/auth/clients/create", "Make the key")}</p>`,
    },
    {
      title: "Paste the key here",
      body: client.id
        ? `<p>Key saved ✓ <span class="dim small">(${e(client.id.slice(0, 14))}…${client.from === "secrets" ? ", from Cloudflare secrets" : ""})</span></p>
          ${client.from === "app" ? `<form method="post" action="/admin/google/setup/remove" onsubmit="return confirm('Remove the Google key? Google Docs, Calendar and Gmail stop until a new one is pasted.')"><button class="btn ghost small">Remove the key</button></form>` : ""}`
        : `<p>Google shows a <b>Client ID</b> and a <b>Client secret</b>. Copy each one into the boxes below.</p>
          <form method="post" action="/admin/google/setup" class="key-form">
            <label>Client ID<input name="client_id" required autocomplete="off" spellcheck="false" placeholder="….apps.googleusercontent.com"></label>
            <label>Client secret<input name="client_secret" type="password" required autocomplete="off" spellcheck="false" placeholder="GOCSPX-…"></label>
            <button class="btn">Save</button>
          </form>`,
    },
    {
      title: "Connect the studio's Google account",
      body: `<p>${account ? `Connected as <b>${e(account)}</b> ✓` : "Press the button and pick the studio's Google account. Tick every box."}</p>
        <p class="dim small">Google may say the app isn't verified. Press <b>Advanced</b>, then <b>Go to Nova Agent</b>. That's expected.</p>
        <p><button type="button" class="btn big" data-connect ${client.id ? "" : "disabled"}>${account ? "Connect again" : "Connect Google"}</button></p>`,
    },
  ];
  const first = client.id ? steps.length - 1 : 0;

  const body = `
  <h2>Google</h2>
  <div class="card google-status"><p><b>${e(status)}</b></p>
    <p class="dim small">Once set up: Notes can save to Google Docs, and bookings use the studio's Google Calendar and Gmail. (Signing in is always with Portal.)</p></div>

  <div class="card wizard" data-first="${first}">
    <p class="kicker" data-progress></p>
    ${steps.map((s, i) => `<section class="step" data-step="${i}" hidden><h3>${i + 1}. ${e(s.title)}</h3>${s.body}</section>`).join("")}
    <div class="step-nav">
      <button type="button" class="btn ghost" data-back>Back</button>
      <button type="button" class="btn" data-next>Next</button>
    </div>
  </div>

  <style>
    .copy-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
    .copy-row code { flex: 1; min-width: 0; overflow-wrap: anywhere; padding: 8px 10px; border-radius: 10px; background: var(--glass); }
    .wizard .step h3 { margin-top: 0; }
    .step-nav { display: flex; justify-content: space-between; gap: 8px; margin-top: 14px; }
    .key-form { display: grid; gap: 10px; max-width: 520px; }
    .key-form label { display: grid; gap: 4px; font-size: 13px; }
    .key-form input { padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line); background: var(--glass); color: inherit; font: inherit; width: 100%; }
    .btn.big { font-size: 16px; padding: 12px 22px; }
  </style>
  <script>
  (() => {
    const wiz = document.querySelector(".wizard");
    const steps = [...wiz.querySelectorAll(".step")];
    let at = Number(wiz.dataset.first) || 0;
    const show = () => {
      steps.forEach((s, i) => (s.hidden = i !== at));
      wiz.querySelector("[data-progress]").textContent = "Step " + (at + 1) + " of " + steps.length;
      wiz.querySelector("[data-back]").disabled = at === 0;
      wiz.querySelector("[data-next]").hidden = at === steps.length - 1;
    };
    wiz.querySelector("[data-back]").onclick = () => { at = Math.max(0, at - 1); show(); };
    wiz.querySelector("[data-next]").onclick = () => { at = Math.min(steps.length - 1, at + 1); show(); };
    show();
    for (const b of document.querySelectorAll("[data-copy]")) {
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied ✓"; } catch (err) { b.textContent = "Select and copy"; }
        setTimeout(() => (b.textContent = "Copy"), 1600);
      };
    }
    // Google's pages can't open inside Nova Agent: a small window, then back here
    const connect = document.querySelector("[data-connect]");
    if (connect) connect.onclick = () => {
      const standalone = matchMedia("(display-mode: standalone)").matches;
      const href = ${JSON.stringify(origin)} + "/admin/google" + (standalone ? "" : "?popup=1");
      if (standalone) { window.top.location.href = href; return; }
      window.open(href, "nova-google", "width=520,height=700");
    };
    addEventListener("message", (ev) => { if (ev.data && ev.data.type === "nova-google") location.reload(); });
  })();
  </script>`;
  return page(env, "Google", url, body);
}

export async function saveGoogleSetup(env, form) {
  const id = String(form.get("client_id") || "").trim();
  const secret = String(form.get("client_secret") || "").trim();
  // (Google only looks at the ID and secret here, so any address does for the check)
  const problem = clientProblem(id, secret) || (await keyProblemWithGoogle(id, secret, PC_ORIGIN, env));
  if (problem) return problem;
  await saveClient(env, id, secret);
  return "";
}

export { removeClient };
