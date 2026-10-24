// Portal → Admin → Test booking: run a pretend booking to check the booking flow
// still works, without real money and without emailing or alerting anyone else
// (the steps and safety rules are in src/nova/test-booking.js).
//
//   GET  /admin/test-booking          the page
//   GET  /admin/test-booking/state    what's set up, the sessions, a quiet slot, the test bookings
//   GET  /admin/test-booking/times?session=&date=   free start times that day
//   POST /admin/test-booking/run      { session, date, time, payment: "skip"|"fake", blockSlot, emailMe, alertMe }
//   POST /admin/test-booking/remove   remove every test booking (and its calendar event)
//
// Admins only: admin.js checks that (and the Origin header on every POST) before
// anything here runs; each route checks the admin again.

import { freeTimesOn, getSessionTypes } from "./nova/booking.js";
import { listTestBookings, quietSlot, removeTestBookings, runTestBooking, testBookingFacts } from "./nova/test-booking.js";

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function handleTestBooking(request, env, url, admin, page) {
  if (!admin || admin.role !== "admin") return json({ error: "Admins only" }, 403);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/admin/test-booking" && method === "GET") return testBookingPage(env, url, page, admin);

  if (path === "/admin/test-booking/state" && method === "GET") {
    const sessions = getSessionTypes();
    const session = Number(url.searchParams.get("session")) || sessions[0].id;
    let quiet = null;
    try {
      quiet = await quietSlot(env, session);
    } catch (err) {
      console.log("Couldn't find a quiet slot for a test booking:", err?.message);
    }
    return json({ facts: await testBookingFacts(env), sessions, session, quiet, bookings: await listTestBookings(env) });
  }

  if (path === "/admin/test-booking/times" && method === "GET") {
    try {
      return json(await freeTimesOn(env, url.searchParams.get("session"), url.searchParams.get("date")));
    } catch (err) {
      return json({ problem: "The studio calendar couldn't be read just now." }, 502);
    }
  }

  if (path === "/admin/test-booking/run" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const out = await runTestBooking(env, admin, {
      session: Number(body.session),
      date: typeof body.date === "string" ? body.date.slice(0, 10) : "",
      time: typeof body.time === "string" ? body.time.slice(0, 5) : "",
      payment: body.payment === "fake" ? "fake" : "skip",
      blockSlot: body.blockSlot === true,
      emailMe: body.emailMe === true,
      alertMe: body.alertMe === true,
    });
    return json({ ...out, bookings: await listTestBookings(env) });
  }

  if (path === "/admin/test-booking/remove" && method === "POST") {
    const out = await removeTestBookings(env);
    return json({ ok: out.kept.length === 0, ...out, bookings: await listTestBookings(env) });
  }

  return json({ error: "Not found" }, 404);
}

// Safe inside a <script>: JSON with "<" escaped, so nothing can close the tag
const forScript = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

async function testBookingPage(env, url, page, admin) {
  const body = `
  <h1>Test booking</h1>

  <details class="tb-system" id="tb-fold" open>
  <summary><h2>Nova's own booking system <span class="small dim">Google Calendar, Gmail and Stripe</span> <b class="tb-live" id="tb-live">LIVE</b></h2></summary>
  <p class="dim">Check the booking flow still works, end to end, without anyone paying. A test booking is marked
    <b class="tb-test">TEST</b> everywhere, uses made-up details, never emails or alerts a client or other staff,
    isn't counted, doesn't block customers' times unless you choose, and removes itself after 24 hours.</p>
  <p class="small dim" id="tb-facts">Checking what's set up…</p>

  <div class="card tb-form">
    <label>Session
      <select id="tb-session"></select>
    </label>
    <div class="tb-when">
      <label>Day <input type="date" id="tb-date"></label>
      <label>Start (UK time) <select id="tb-time"><option value="">…</option></select></label>
    </div>
    <p class="small dim" id="tb-quiet"></p>

    <fieldset class="tb-pay">
      <legend>Payment</legend>
      <label><input type="radio" name="tb-pay" value="skip" checked> Skip payment <span class="dim small">(recorded as "payment bypassed: test"; Stripe isn't contacted)</span></label>
      <label><input type="radio" name="tb-pay" value="fake"> Fake a payment <span class="dim small" id="tb-fake-how"></span></label>
    </fieldset>

    <fieldset class="tb-opts">
      <legend>Options</legend>
      <label><input type="checkbox" id="tb-email"> Email the confirmation to me too <span class="dim small" id="tb-me"></span></label>
      <label><input type="checkbox" id="tb-alert"> Send the alert to my own phones <span class="dim small">(nobody else's)</span></label>
      <label><input type="checkbox" id="tb-block"> Let it block the time for customers <span class="dim small">(off: customers can still book it)</span></label>
    </fieldset>

    <p><button class="btn" id="tb-run" type="button">Run test booking</button> <span class="small dim" id="tb-why"></span></p>
  </div>

  <section id="tb-result" hidden>
    <h2>Result <span id="tb-verdict"></span></h2>
    <ol class="tb-steps" id="tb-steps"></ol>
    <details class="card" id="tb-email-box" hidden>
      <summary>Confirmation email (preview)</summary>
      <p class="small"><b id="tb-email-subject"></b> <span class="dim" id="tb-email-to"></span></p>
      <iframe id="tb-email-frame" class="tb-email-frame" title="Email preview" sandbox=""></iframe>
    </details>
    <details class="card" id="tb-alert-box" hidden>
      <summary>Alert (preview)</summary>
      <pre class="tb-alert" id="tb-alert-text"></pre>
    </details>
  </section>

  <h2>Test bookings</h2>
  <div class="card">
    <table>
      <thead><tr><th>Booking</th><th>When (UK)</th><th>Session</th><th>Paid</th><th>Blocks customers?</th><th>Made (UK)</th></tr></thead>
      <tbody id="tb-list"><tr><td colspan="6" class="dim">Loading…</td></tr></tbody>
    </table>
    <p><button class="btn ghost" id="tb-remove" type="button">Remove all test bookings</button>
      <span class="small dim">Removes each one, its calendar event, its payment record, its emails and its alerts.</span></p>
    <p class="small" id="tb-remove-msg" role="status"></p>
  </div>
  </details>

  <style>
    .tb-test { display: inline-block; padding: 0 6px; border-radius: 6px; border: 1px solid currentColor; font-size: 0.85em; letter-spacing: 0.08em; color: var(--warn, #ffb347); }
    .tb-form label { display: block; margin: 8px 0; }
    .tb-form select, .tb-form input[type=date] { display: block; margin-top: 4px; max-width: 100%; }
    .tb-when { display: flex; flex-wrap: wrap; gap: 0 16px; }
    .tb-form fieldset { border: 1px solid var(--line, #3a2550); border-radius: 12px; margin: 12px 0; padding: 6px 12px; }
    .tb-form fieldset label { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .tb-steps { list-style: none; padding: 0; margin: 0 0 16px; }
    .tb-steps li { display: grid; grid-template-columns: 28px 1fr; gap: 2px 10px; padding: 10px 12px; margin: 6px 0; border-radius: 12px; border: 1px solid var(--line, #3a2550); }
    .tb-steps .mark { grid-row: span 2; font-size: 18px; line-height: 1.2; text-align: center; }
    .tb-steps .detail { font-size: 0.92em; opacity: 0.85; overflow-wrap: anywhere; }
    .tb-steps li.pass .mark { color: #5fd38d; }
    .tb-steps li.fail { border-color: #ff6b6b; }
    .tb-steps li.fail .mark { color: #ff6b6b; }
    .tb-steps li.skip .mark, .tb-steps li.waiting .mark { opacity: 0.6; }
    .tb-email-frame { width: 100%; height: 520px; border: 0; border-radius: 12px; background: #100816; }
    .tb-alert { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9em; margin: 8px 0 0; }
    #tb-verdict.pass { color: #5fd38d; }
    #tb-verdict.fail { color: #ff6b6b; }
    .tb-system { margin: 18px 0; }
    .tb-system > summary { cursor: pointer; list-style: none; }
    .tb-system > summary::-webkit-details-marker { display: none; }
    .tb-system > summary h2 { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; }
    .tb-system > summary h2::before { content: "▸"; font-size: 0.8em; opacity: 0.7; transition: transform 0.2s; }
    .tb-system[open] > summary h2::before { transform: rotate(90deg); }
    .tb-live { padding: 0 6px; border-radius: 6px; font-size: 0.6em; letter-spacing: 0.1em; color: #5fd38d; border: 1px solid currentColor; }
    .tb-check { display: flex !important; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  </style>

  <script>
  (() => {
    const $ = (id) => document.getElementById(id);
    const STEPS = [["slot", "Slot found"], ["booking", "Booking created"], ["payment", "Payment"], ["email", "Confirmation email"], ["calendar", "Calendar event"], ["alerts", "Alerts"]];
    const MARK = { pass: "✓", fail: "✗", skip: "–", waiting: "…" };
    let quiet = null;
    let novaReady = true;

    const api = async (path, body) => {
      const res = await fetch("/admin/test-booking/" + path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.problem || "Something went wrong (" + res.status + ")");
      return data;
    };
    const cell = (text, label) => { const td = document.createElement("td"); td.textContent = text; if (label) td.dataset.label = label; return td; };

    function showList(bookings) {
      const list = $("tb-list");
      list.replaceChildren();
      if (!bookings.length) {
        const tr = document.createElement("tr");
        const td = cell("None.");
        td.colSpan = 6; td.className = "dim";
        tr.append(td); list.append(tr);
        return;
      }
      for (const b of bookings) {
        const tr = document.createElement("tr");
        const first = cell("", "Booking");
        const tag = document.createElement("b"); tag.className = "tb-test"; tag.textContent = "TEST";
        first.append(tag, " #" + b.id + (b.status !== "booked" ? " (" + b.status + ")" : ""));
        tr.append(first, cell(b.when, "When (UK)"), cell(b.session, "Session"), cell(b.paid, "Paid"), cell(b.blocks ? "Yes" : "No", "Blocks customers?"), cell(b.created_uk, "Made (UK)"));
        list.append(tr);
      }
    }

    function showSteps(steps, olId = "tb-steps") {
      const ol = $(olId);
      ol.replaceChildren();
      for (const s of steps) {
        const li = document.createElement("li");
        li.className = s.status;
        const mark = document.createElement("span"); mark.className = "mark"; mark.textContent = MARK[s.status] || "…";
        mark.setAttribute("aria-label", s.status === "pass" ? "passed" : s.status === "fail" ? "failed" : s.status === "skip" ? "skipped" : "waiting");
        const label = document.createElement("b"); label.textContent = s.label;
        const detail = document.createElement("span"); detail.className = "detail"; detail.textContent = s.detail || "";
        li.append(mark, label, detail);
        ol.append(li);
      }
    }

    async function loadTimes() {
      const session = $("tb-session").value, date = $("tb-date").value;
      const sel = $("tb-time");
      sel.replaceChildren(new Option("…", ""));
      if (!date) return;
      if (!novaReady) { sel.replaceChildren(new Option("Google isn't connected", "")); return; }
      try {
        const data = await api("times?session=" + encodeURIComponent(session) + "&date=" + encodeURIComponent(date));
        sel.replaceChildren();
        if (data.problem || !data.times || !data.times.length) { sel.append(new Option(data.problem || "Nothing free that day", "")); return; }
        for (const t of data.times) sel.append(new Option(t, t));
        sel.value = quiet && quiet.date === date && data.times.includes(quiet.time) ? quiet.time : data.times[data.times.length - 1];
      } catch (err) {
        sel.replaceChildren(new Option(err.message, ""));
      }
    }

    async function load(session) {
      const data = await api("state" + (session ? "?session=" + encodeURIComponent(session) : ""));
      const f = data.facts;
      const sel = $("tb-session");
      if (!sel.options.length) for (const t of data.sessions) sel.append(new Option(t.name + " (" + t.price + ")", t.id));
      sel.value = String(data.session);
      $("tb-facts").textContent =
        "This is the live booking system. " +
        (f.sandbox ? "Sandbox: Google and email work offline. " : f.google ? "" : "Google isn't connected, so this test can't run yet (Admin → Google). ") +
        "Up to " + f.max + " test bookings at once.";
      // Without Google there's no calendar to find free times in or book into
      novaReady = Boolean(f.sandbox || f.google);
      $("tb-run").disabled = !novaReady;
      $("tb-why").textContent = novaReady ? "" : "Connect Google first (Admin → Google).";
      $("tb-fake-how").textContent = f.stripe === "test"
        ? "(Stripe's test mode and test card: no real money)"
        : f.stripe === "live-only"
          ? "(only a live Stripe key is set, so Stripe won't be contacted: the payment is simulated)"
          : "(no Stripe test key, so Stripe won't be contacted: the payment is simulated)";
      quiet = data.quiet;
      $("tb-quiet").textContent = quiet ? "A quiet slot about four weeks ahead is picked for you; change it if you like." : novaReady ? "Couldn't find a quiet slot: pick a day." : "";
      if (quiet) $("tb-date").value = quiet.date;
      await loadTimes();
      showList(data.bookings);
    }

    $("tb-session").addEventListener("change", () => load($("tb-session").value).catch((err) => ($("tb-facts").textContent = err.message)));
    $("tb-date").addEventListener("change", loadTimes);

    $("tb-run").addEventListener("click", async () => {
      const btn = $("tb-run");
      btn.disabled = true; btn.textContent = "Running…";
      $("tb-result").hidden = false;
      $("tb-verdict").textContent = ""; $("tb-verdict").className = "";
      $("tb-email-box").hidden = true; $("tb-alert-box").hidden = true;
      showSteps(STEPS.map(([key, label]) => ({ key, label, status: "waiting", detail: "" })));
      try {
        const out = await api("run", {
          session: Number($("tb-session").value),
          date: $("tb-date").value,
          time: $("tb-time").value,
          payment: document.querySelector('input[name="tb-pay"]:checked').value,
          emailMe: $("tb-email").checked,
          alertMe: $("tb-alert").checked,
          blockSlot: $("tb-block").checked,
        });
        showSteps(out.steps);
        $("tb-verdict").textContent = out.ok ? "· passed" : "· failed";
        $("tb-verdict").className = out.ok ? "pass" : "fail";
        if (out.email) {
          $("tb-email-box").hidden = false;
          $("tb-email-subject").textContent = out.email.subject;
          $("tb-email-to").textContent = out.email.to ? "sent to " + out.email.to + " only" : "not sent";
          $("tb-email-frame").srcdoc = out.email.html;
        }
        if (out.alert) {
          $("tb-alert-box").hidden = false;
          $("tb-alert-text").textContent = out.alert.title + "\\n\\n" + out.alert.body;
        }
        showList(out.bookings || []);
        await loadTimes();
      } catch (err) {
        showSteps([{ key: "error", label: "Couldn't run it", status: "fail", detail: err.message }]);
        $("tb-verdict").textContent = "· failed"; $("tb-verdict").className = "fail";
      } finally {
        btn.disabled = !novaReady; btn.textContent = "Run test booking";
      }
    });

    $("tb-remove").addEventListener("click", async () => {
      if (!confirm("Remove every test booking, with its calendar event? Real bookings aren't touched.")) return;
      const btn = $("tb-remove");
      btn.disabled = true;
      try {
        const out = await api("remove", {});
        $("tb-remove-msg").textContent = (out.removed === 1 ? "Removed 1 test booking." : "Removed " + out.removed + " test bookings.") +
          (out.kept.length ? " Couldn't remove " + out.kept.map((k) => "#" + k.id + ": " + k.why).join("; ") + ". Try again in a minute." : "");
        showList(out.bookings || []);
        await loadTimes();
      } catch (err) {
        $("tb-remove-msg").textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });

    $("tb-me").textContent = "(only to you: " + ${forScript(String(admin.email || ""))} + ")";
    load().catch((err) => ($("tb-facts").textContent = err.message));
  })();
  </script>`;
  return page(env, "Test booking", url, body);
}
