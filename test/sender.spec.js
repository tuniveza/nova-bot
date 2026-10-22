// A sender setting that holds a key, not an address (22 Oct 2026: ENQUIRY_EMAIL_FROM held a Stripe
// secret key and Portal showed it as the sender): it's never shown, and never sent from.
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailIsSetUp, emailRecipients, looksLikeKey, pickSender, sendEmail } from "../src/enquiries.js";

const KEY = "sk_live_" + "51Gexample000000000000000000";

describe("sender addresses", () => {
  afterEach(() => vi.restoreAllMocks());
  it("knows a key from an address", () => {
    expect(looksLikeKey(KEY)).toBe(true);
    expect(looksLikeKey("whsec_abc")).toBe(true);
    expect(looksLikeKey("Novacane Studios <hello@novacane.co.uk>")).toBe(false);
  });
  it("picks the first real address, skipping a key and an empty setting", () => {
    expect(pickSender("", KEY, "Studio <hello@novacane.co.uk>")).toBe("Studio <hello@novacane.co.uk>");
    expect(pickSender(KEY)).toBe("");
    expect(pickSender(`${KEY}@x.com`)).toBe("");
  });
  it("never sends to a key, and doesn't count one as set up", async () => {
    const env = { MAIL_API_URL: "http://mail.test", MAIL_KEY: "k", ENQUIRY_EMAIL_TO: KEY };
    expect(emailRecipients(env)).toEqual([]);
    expect(emailIsSetUp(env)).toBe(false);
    expect(emailRecipients({ ENQUIRY_EMAIL_TO: `a@b.c, ${KEY}` })).toEqual(["a@b.c"]);
  });
  it("never sends from a key", async () => {
    const sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    await sendEmail({ MAIL_API_URL: "http://mail.test", MAIL_KEY: "k", ENQUIRY_EMAIL_TO: "a@b.c", ENQUIRY_EMAIL_FROM: KEY }, { subject: "Hi", text: "Hi" });
    expect(sent[0].from).toBe("Novacane Studios <hello@novacane.co.uk>");
    expect(JSON.stringify(sent)).not.toContain("sk_live_");
  });
});
