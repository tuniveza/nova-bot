// Daily health check: can Nova Bot still reach Google (calendar and email) and Stripe (payments)?
//
// Every day at 06:00 UK (from the every-minute cron), check both. If either has
// stopped working (Google access removed, a Stripe key rolled), staff phones get
// a notification straight away instead of finding out from a customer.
//
// (Alerts from Nova Agent, the browser helper, arrive through agent-nova.js.)

import { googleProblem, googleReady } from "./google.js";
import { notifyPhones } from "../push.js";
import { stripeProblem } from "./stripe.js";

// When the daily check runs (UK time, "HH:MM")
const CHECK_AT = "06:00";

// Called every minute by the cron; only does anything at CHECK_AT
export async function dailyHealthCheck(env, now = new Date()) {
  if (ukTime(now) !== CHECK_AT) return;
  const problems = [];
  // Not connected at all means bookings were never switched on: nothing has broken
  if (env.GOOGLE_CLIENT_ID || (await googleReady(env))) {
    const google = await googleProblem(env);
    if (google) problems.push("Google: " + google);
  }
  if (env.STRIPE_SECRET_KEY) {
    const stripe = await stripeProblem(env);
    if (stripe) problems.push("Stripe: " + stripe);
  }
  if (!problems.length) return;
  console.log("Daily health check failed:", problems.join(" | "));
  await notifyPhones(env, {
    title: "Bookings need attention",
    body: `${problems.join("\n")}\nUntil it's fixed, online booking, emails or payments may not work. Check /admin/connections.`,
    url: "/app/",
  });
}

// "06:00", the time now in the UK
function ukTime(now) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}
