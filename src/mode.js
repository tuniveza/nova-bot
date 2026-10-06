// Which booking system NovaBot uses: a behind-the-scenes switch.
//
//   "acuity" (the default)  bookings go through Acuity, as they always have:
//                           Acuity's booking page, Nova Agent, Acuity's webhook,
//                           emails and calendar feed.
//   "nova"                  Nova Bot's own booking system (src/nova/): its booking
//                           page (/book), the studio's Google Calendar, Gmail and
//                           Stripe deposits. No Acuity.
//
// The switch is the "booking_system" setting (flipped on /admin/connections,
// no redeploy needed). Without it, the BOOKING_SYSTEM variable decides, and
// without that, it's Acuity.
//
// Whichever is on, the other's links keep working: a customer who booked with
// Nova Bot can still pay, move or cancel on their booking page, and Acuity's
// webhook is still listened to.

export const BOOKING_SYSTEMS = ["acuity", "nova"];

export async function bookingSystem(env) {
  try {
    const value = await env.DB.prepare("SELECT value FROM settings WHERE key = 'booking_system'").first("value");
    if (BOOKING_SYSTEMS.includes(value)) return value;
  } catch (err) {
    console.log("Couldn't read the booking system switch (using the default):", err);
  }
  return env.BOOKING_SYSTEM === "nova" ? "nova" : "acuity";
}

export const usesNova = async (env) => (await bookingSystem(env)) === "nova";

export async function setBookingSystem(env, value) {
  if (!BOOKING_SYSTEMS.includes(value)) throw new Error("Unknown booking system: " + value);
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('booking_system', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(value)
    .run();
}
