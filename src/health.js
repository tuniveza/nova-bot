// Daily health check: can NovaBot still reach Acuity's API?
//
// Every day at 06:00 UK (from the every-minute cron), check that the
// ACUITY_USER_ID / ACUITY_API_KEY secrets still work. If the key stops
// working, chat bookings and staff booking changes stop working too, so staff
// phones get a notification straight away instead of finding out from a
// customer.
//
// (Alerts from Nova Agent, the browser helper, arrive through agent-nova.js.)

import { ukToday } from "./booking.js";
import { notifyPhones } from "./push.js";

const ACUITY_API = "https://acuityscheduling.com/api/v1";

// When the daily check runs (UK time, "HH:MM")
const CHECK_AT = "06:00";

// Called every minute by the cron; only does anything at CHECK_AT
export async function dailyAcuityCheck(env, now = new Date()) {
  if (ukTime(now) !== CHECK_AT) return;
  // Without the keys, NovaBot doesn't offer bookings at all, so nothing is broken
  if (!env.ACUITY_USER_ID || !env.ACUITY_API_KEY) return;

  const problem = await acuityProblem(env, now);
  if (!problem) return;
  console.log("Daily Acuity check failed:", problem);
  await notifyPhones(env, {
    title: "NovaBot can't reach Acuity",
    body: `${problem}\nUntil it's fixed, NovaBot can't book sessions or change bookings. Check the ACUITY_API_KEY secret in Cloudflare.`,
    url: "/app/",
  });
}

// Ask Acuity for one booking. Returns what's wrong, or "" if all is well.
async function acuityProblem(env, now) {
  try {
    const res = await fetch(`${ACUITY_API}/appointments?max=1&minDate=${ukToday(now)}`, {
      headers: { Authorization: "Basic " + btoa(`${env.ACUITY_USER_ID.trim()}:${env.ACUITY_API_KEY.trim()}`) },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) return "Acuity refused the API key (it may have been changed or the plan downgraded).";
    if (!res.ok) return `Acuity's API answered with an error (${res.status}).`;
    return "";
  } catch (err) {
    return `Acuity's API didn't answer (${String(err?.message || err).slice(0, 100)}).`;
  }
}

// "06:00", the time now in the UK
function ukTime(now) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}
