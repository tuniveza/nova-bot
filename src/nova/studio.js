// The studio's booking rules: sessions, prices, opening hours, deposit and
// cancellation policy. This replaces what used to be set up in Acuity.
//
// ===== THINGS YOU CAN EDIT =====
// Change a price or a session here, run the tests (npm test), then deploy.
// Session IDs are kept from Acuity so old links and chat history still match;
// a new session just needs a new unique number.

// The studio's sessions. duration and changeover are minutes; changeover is
// time kept free after the session (packing down, the next artist setting up).
export const SESSION_TYPES = [
  { id: 11846136, name: "Rap Package - 1 song (1 hour recording with engineer + 1 hour mixing)", price: 100, duration: 120, changeover: 30 },
  { id: 64806309, name: "Rap Package - 2 songs (2 hours recording with engineer + 2 hours mixing)", price: 200, duration: 240, changeover: 30 },
  { id: 64806346, name: "Rap Package - 4 songs (4 hours recording with engineer + 4 hours mixing)", price: 400, duration: 480, changeover: 30 },
  { id: 64806400, name: "Singer Package - 1 song (2 hours recording with engineer + 2 hours mixing)", price: 200, duration: 240, changeover: 30 },
  { id: 64806426, name: "Singer Package - 2-3 songs (4 hours recording with engineer + 4 hours mixing)", price: 400, duration: 480, changeover: 30 },
  { id: 46439753, name: "Custom Music Production", price: 250, duration: 180, changeover: 30 },
  { id: 12738216, name: "Voiceover Recording with Engineer - 1 hour", price: 80, duration: 60, changeover: 30 },
  { id: 11843895, name: "Voiceover Recording with Engineer - 2 hours", price: 140, duration: 120, changeover: 30 },
  { id: 12798257, name: "Voiceover Recording with Engineer - 4 hours (Half Day)", price: 240, duration: 240, changeover: 30 },
  { id: 11846113, name: "Voiceover Recording with Engineer - 8 hours (Full Day)", price: 400, duration: 480, changeover: 30 },
  { id: 11846178, name: "Studio Rental without Engineer - 2 hours", price: 60, duration: 120, changeover: 0 },
  { id: 11846196, name: "Studio Rental without Engineer - 4 Hours (Half Day)", price: 120, duration: 240, changeover: 0 },
  { id: 11846238, name: "Studio Rental without Engineer - 8 hours (Full Day)", price: 200, duration: 480, changeover: 0 },
];

// Opening hours, UK time, by day (0 = Sunday). A session and its changeover
// must finish by closing. null = closed all day.
export const OPENING_HOURS = {
  0: ["10:00", "23:00"],
  1: ["10:00", "23:00"],
  2: ["10:00", "23:00"],
  3: ["10:00", "23:00"],
  4: ["10:00", "23:00"],
  5: ["10:00", "23:00"],
  6: ["10:00", "23:00"],
};

// Start times are offered every this many minutes from opening
export const SLOT_STEP_MINUTES = 30;
// The soonest a session can be booked online, from now
export const MIN_NOTICE_MINUTES = 60;
// How far ahead bookings can be made
export const MAX_DAYS_AHEAD = 180;

// The deposit that secures a booking, as a share of the price (50%)
export const DEPOSIT_PERCENT = 50;

// Cancelling or moving with less than this much notice loses the deposit
export const CANCEL_NOTICE_HOURS = 48;
// Customers can move their own booking (on their booking page) up to this many
// hours before it starts; after that they contact the studio
export const CUSTOMER_MOVE_HOURS = 48;
// When a customer cancels with enough notice, their deposit is refunded:
//   "staff" - staff phones are told to refund it (in Nova Hub: "refund booking 12")
//   "auto"  - Stripe refunds it straight away
export const CUSTOMER_CANCEL_REFUNDS = "staff";

// How long a time is held while the customer pays the deposit at checkout
// (Stripe's minimum is 30 minutes)
export const CHECKOUT_HOLD_MINUTES = 30;
// The day-before reminder goes out this many hours before the session
export const REMINDER_HOURS = 24;

// The studio, for emails and the booking page
export const STUDIO = {
  name: "Novacane Studios",
  website: "https://novacane.co.uk",
  email: "hello@novacane.co.uk",
  whatsapp: "07510 108566",
  whatsappLink: "https://wa.me/447510108566",
  // Shown in emails and calendar invites
  address: "Novacane Studios, London",
};

export const TIME_ZONE = "Europe/London";

// ===== HELPERS (you shouldn't need to change these) =====

export function getType(id) {
  return SESSION_TYPES.find((t) => t.id === Number(id)) || null;
}

// The deposit for a price in pence (rounded to the penny)
export function depositFor(pricePence) {
  return Math.round((pricePence * DEPOSIT_PERCENT) / 100);
}

export const pence = (pounds) => Math.round(Number(pounds) * 100);

// 12345 -> "£123.45", 10000 -> "£100"
export function money(p) {
  const pounds = Math.abs(p) / 100;
  return (p < 0 ? "-" : "") + "£" + (Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2));
}

// ===== UK TIME =====
// Dates are "YYYY-MM-DD" and times "HH:MM" in UK time; instants are UTC ISO strings.

// How far UK time is ahead of UTC at this moment, in ms (0, or an hour in summer)
export function ukOffset(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - Math.floor(ms / 60_000) * 60_000;
}

// "2026-10-22" + "14:15" (UK) -> milliseconds since 1970
export function ukToMs(date, time = "00:00") {
  const wall = Date.parse(`${date}T${time}:00Z`);
  // Two passes get the offset right either side of a clock change
  const first = wall - ukOffset(wall);
  return wall - ukOffset(first);
}

// Milliseconds -> { date: "2026-10-22", time: "14:15" } in UK time
export function msToUk(ms) {
  const local = new Date(ms + ukOffset(ms)).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

// "Thursday 22 October 2026, 14:15–16:15"
export function whenInWords(startIso, endIso) {
  const start = Date.parse(startIso);
  const day = new Date(start).toLocaleDateString("en-GB", { timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(/,/g, "");
  const clock = (ms) => msToUk(ms).time;
  return `${day}, ${clock(start)}${endIso ? "–" + clock(Date.parse(endIso)) : ""}`;
}
