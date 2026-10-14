// "How it works" in Portal: what each part of Nova runs on, and whether it's set up.
//
// For staff and admins to see at a glance that, say, enquiry emails go through the studio's own
// mail server and it's set up. Only names, plain addresses the studio chose (the email "from" and
// where copies go) and yes/no are shown: never a key or a secret's value.

import { emailIsSetUp, emailRecipients, sendEmail } from "./enquiries.js";
import { bookingSystem } from "./mode.js";
import { googleReady } from "./nova/google.js";
import { stripeReady } from "./nova/stripe.js";
import { campaignFrom, campaignsReady } from "./campaigns.js";
import { readyFor } from "./social.js";
import { publicUrl } from "./nova/booking.js";

// One test email per person per this long (the button can't be used to flood an inbox)
const TEST_EMAIL_GAP_MS = 60 * 1000;

// When something last happened, from the database (null if never, or the table isn't there)
async function latest(env, sql) {
  return env.DB.prepare(sql)
    .first("at")
    .catch(() => null);
}

// Is Nova Agent on the studio PC connected right now?
async function pcConnected(env) {
  if (!env.AGENT_LINK) return false;
  try {
    const res = await env.AGENT_LINK.get(env.AGENT_LINK.idFromName("studio-pc")).fetch(new Request("https://agent-link/status"));
    return Boolean((await res.json()).connected);
  } catch {
    return false;
  }
}

// The list Portal shows. ready: true (working), false (not set up) or "partly"; detail: a
// sentence about how it's set up; last: when it last did something (UTC), if that's known.
export async function servicesStatus(env) {
  const from = env.ENQUIRY_REPLY_FROM || env.ENQUIRY_EMAIL_FROM || "";
  const copies = emailRecipients(env);
  const [lastEmail, lastCampaign, lastPost, phones, system, google, pc] = await Promise.all([
    latest(env, "SELECT MAX(sent_at) AS at FROM enquiry_messages WHERE channel = 'email' AND status = 'sent'"),
    latest(env, "SELECT MAX(sent_at) AS at FROM email_campaigns WHERE status = 'sent'"),
    latest(env, "SELECT MAX(posted_at) AS at FROM social_posts WHERE status = 'posted'"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions")
      .first("n")
      .catch(() => 0),
    bookingSystem(env),
    googleReady(env).catch(() => false),
    pcConnected(env),
  ]);
  const stripeKey = String(env.STRIPE_SECRET_KEY || "");
  const stripeMode = stripeKey.startsWith("sk_live_") ? "live" : stripeKey ? "test mode" : "not set up";
  const acuity = Boolean(env.ACUITY_USER_ID && env.ACUITY_API_KEY);

  return [
    {
      id: "email",
      name: "Enquiry emails",
      tech: "The studio's own mail server (on the VPS)",
      ready: emailIsSetUp(env) ? (from ? true : "partly") : false,
      detail: emailIsSetUp(env)
        ? `Replies from Portal go from ${from || "hello@novacane.co.uk (set ENQUIRY_EMAIL_FROM to change it)"}. Copies of new enquiries go to ${copies.join(", ")}.`
        : "Needs the mail server (MAIL_API_URL and MAIL_KEY) and the ENQUIRY_EMAIL_TO setting.",
      last: lastEmail,
      test: emailIsSetUp(env),
    },
    newsletters(env, lastCampaign),
    socialPosts(env, lastPost, pc),
    {
      id: "phone",
      name: "WhatsApp, calls and texts",
      tech: "Your own phone and WhatsApp (the app or WhatsApp Web)",
      ready: true,
      detail: "Portal opens WhatsApp, Messages or your phone's dialler with the customer's number and your reply filled in. You press send or call, so it comes from you. Then Portal asks how it went and adds it to the conversation.",
    },
    {
      id: "push",
      name: "Phone notifications",
      tech: "Web Push (Apple's and Google's notification services)",
      ready: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      detail: `${phones} ${phones === 1 ? "phone has" : "phones have"} notifications on.`,
    },
    {
      id: "ai",
      name: "NovaBot and Agent's AI",
      tech: "Anthropic Claude",
      ready: Boolean(env.ANTHROPIC_API_KEY),
      detail: "NovaBot answers customers on the website. Agent drafts replies, but a person always approves before anything is sent.",
    },
    {
      id: "voice",
      name: "Voice (speaking and listening)",
      tech: "Cloudflare Workers AI (Whisper and MeloTTS)",
      ready: Boolean(env.AI),
      detail: "Turns speech into text and reads answers aloud.",
    },
    {
      id: "bookings",
      name: "Bookings",
      tech: system === "nova" ? "Nova's own booking page, Google Calendar and Gmail" : "Acuity Scheduling",
      ready: system === "nova" ? google : acuity,
      detail: system === "nova" ? "Bookings go into the studio's Google Calendar; booking emails go from its Gmail." : "Bookings, their emails and the booking page are Acuity's.",
    },
    {
      id: "payments",
      name: "Deposits",
      tech: "Stripe",
      ready: system === "nova" ? stripeReady(env) : Boolean(stripeKey) || "partly",
      detail: system === "nova" ? `Stripe is in ${stripeMode}.` : `Only used once bookings move to Nova's own system (Stripe is ${stripeMode}).`,
    },
    {
      id: "pc",
      name: "Nova Agent on the studio PC",
      tech: "A private link from the PC to Nova Bot (Cloudflare)",
      ready: env.AGENT_NOVA_KEY ? (pc ? true : "partly") : false,
      detail: pc ? "Connected now: Agent, Quests, Calendar and Notes work online." : "Not connected right now (the PC may be off). Portal still works.",
    },
    {
      id: "lossless",
      name: "Lossless calls",
      tech: "Cloudflare Realtime (TURN relay)",
      ready: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN),
      detail: env.TURN_KEY_ID ? "Calls connect through Cloudflare when a direct link isn't possible." : "Works on most connections; add the TURN keys for calls through strict networks.",
    },
    {
      id: "hosting",
      name: "Website, Portal and data",
      tech: "Cloudflare Workers and D1 (database)",
      ready: true,
      detail: "Nova Bot, Portal and every panel online run here, and the studio's data is kept here.",
    },
  ];
}

// Email newsletters (src/campaigns.js): ready with the studio's mail server and the from address
function newsletters(env, last) {
  const from = campaignFrom(env);
  const ready = campaignsReady(env);
  return {
    id: "newsletters",
    name: "Email newsletters",
    tech: "The studio's own mail server (on the VPS), a few emails a minute",
    ready,
    detail: !ready
      ? "Needs the studio's mail server (MAIL_API_URL and MAIL_KEY) and the address campaigns come from (CAMPAIGN_FROM)."
      : `Campaigns go from ${from} only to people who opted in (confirmed fans, and clients who said yes), and only after an admin approves them in Portal → Campaigns. Each email has its own unsubscribe link. Fans sign up at ${publicUrl(env)}/join.`,
    last,
  };
}

// Facebook and Instagram posts (src/social.js): posted by Meta's Graph API once META_PAGE_TOKEN and
// the Page's (and Instagram account's) ids are set; until then, approved posts wait to be posted by hand
function socialPosts(env, last, pc) {
  const on = readyFor(env);
  const both = on.facebook && on.instagram;
  const one = on.facebook || on.instagram;
  return {
    id: "social",
    name: "Social posts",
    tech: "Meta's Graph API (Facebook Page and Instagram); pictures and videos kept on the studio computer",
    ready: both ? true : one ? "partly" : false,
    detail: `${
      both
        ? "Approved posts go out on Facebook and Instagram by themselves."
        : one
          ? `Approved posts go out on ${on.facebook ? "Facebook" : "Instagram"} by themselves; ${on.facebook ? "Instagram" : "Facebook"} posts wait to be posted by hand (set ${on.facebook ? "META_IG_USER_ID" : "META_PAGE_ID"} to connect it).`
          : "Not connected to Meta yet (the META_PAGE_TOKEN, META_PAGE_ID and META_IG_USER_ID secrets), so approved posts wait in Portal → Social for someone to post them by hand."
    } Nothing is posted until an admin approves it. The pictures and videos are on the studio computer, so it has to be on when a post goes out${pc ? "" : " (it's off or offline right now)"}.`,
    last,
  };
}

// "Send me a test email": proves the mail server works by emailing the person who pressed it (only them)
export async function testEmailToMe(env, me) {
  if (!emailIsSetUp(env)) return { status: 409, error: "Email isn't set up yet (it needs the mail server, MAIL_API_URL and MAIL_KEY, and ENQUIRY_EMAIL_TO)." };
  const to = String(me.email || "").trim();
  if (!to) return { status: 409, error: "Your account has no email address." };
  const key = "test_email_" + me.id;
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value");
  if (last && Date.now() - Date.parse(last) < TEST_EMAIL_GAP_MS) return { status: 429, error: "One just went. Wait a minute before sending another." };
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, new Date().toISOString()).run();
  const result = await sendEmail(env, {
    to: [to],
    from: env.ENQUIRY_REPLY_FROM || env.ENQUIRY_EMAIL_FROM || undefined,
    subject: "Test email from Portal",
    text: `This is a test from Portal's "How it works" page, sent by the studio's own mail server. If you're reading this, emails from Nova are working.`,
  });
  return result.ok ? { ok: true, to, message: `Sent to ${to}. Check the inbox (and spam).` } : { status: 502, error: result.message };
}
