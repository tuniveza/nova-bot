// Words that say "this was a test" (Portal → Test stuff, src/tidy.js). One small list, so it's easy
// to add to. Matched as whole words, ignoring capitals. Nova Agent keeps the same list for the PC's
// quests and calendar (src/tidy-words.ts there): change both together.

// Said by people trying things out
export const TEST_WORDS = ["test", "tests", "testing", "tester", "asdf", "asdfgh", "qwerty", "lorem", "ipsum", "dummy", "placeholder", "blah", "foobar", "xyz123", "abc123", "fake", "fakename"];

// Rude or joke words nobody puts in a real booking, note or quest
export const JOKE_WORDS = [
  "shit", "shite", "fuck", "fucking", "shag", "shagger", "dildo", "wank", "wanker", "piss", "pissed", "bollocks", "bellend",
  "knob", "knobhead", "twat", "arse", "arsehole", "willy", "fart", "farts", "poo", "poop", "wee", "burp", "filthy", "spanker",
  "tonker", "phallic", "your mum", "ur mum", "my johnson",
];

// Names seen in the studio's own tests (whole names)
export const TEST_NAMES = [
  "bollard baxter", "sensual shagger", "shit head", "pillic poor", "tillard tonker", "bent brandon", "trilliant texter",
  "rosen ronald", "mitchel doner", "tree wood thacker", "ronald spanker", "dildo twaine", "john doe", "jane doe", "joe bloggs",
];

// Email addresses that can't be anyone's: reserved test domains
export const TEST_DOMAINS = ["example.com", "example.org", "example.net", "example.co.uk", "test.com", "test.co.uk", "email.com"];
export const TEST_TLDS = [".test", ".invalid", ".example", ".localhost"];

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const pattern = (words) => new RegExp(`(^|[^a-z0-9])(${words.map(escape).join("|")})(?=$|[^a-z0-9])`, "gi");
const TEST_RE = pattern(TEST_WORDS);
const JOKE_RE = pattern(JOKE_WORDS);

// The list's words found in a text -> ["test", …] (lower-case, each once)
function found(re, text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(re)) out.add(m[2].toLowerCase().replace(/\s+/g, " "));
  return [...out];
}
export const testWordsIn = (text) => found(TEST_RE, text);
export const jokeWordsIn = (text) => found(JOKE_RE, text);
export const isTestName = (name) => TEST_NAMES.includes(String(name || "").trim().toLowerCase().replace(/\s+/g, " "));

// An email address that's made up: a reserved domain, or a "test@" name
export function testEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const [local, domain = ""] = e.split("@");
  if (!domain) return null;
  if (TEST_DOMAINS.includes(domain) || TEST_TLDS.some((t) => domain.endsWith(t))) return `a made-up email address (${domain})`;
  if (/^(test|testing|tester|fake|asdf|qwerty|noreply-test)\d*$/.test(local)) return `a test email name (${local}@)`;
  return null;
}

// Ofcom's numbers set aside for TV and films: never anyone's real phone
const DRAMA = [/^447700900\d{3}$/, /^441632960\d{3}$/, /^442079460\d{3}$/, /^44(113|114|115|116|117|118|121|131|141|151|161)4960\d{3}$/, /^442896496\d{3}$/, /^442920180\d{3}$/, /^441914980\d{3}$/, /^448081570\d{3}$/, /^449098790\d{3}$/];
export function dramaPhone(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (!d) return false;
  if (d.startsWith("0")) d = "44" + d.slice(1);
  return DRAMA.some((re) => re.test(d));
}
