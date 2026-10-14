// Ask Index: a question in plain English, answered only from what Index remembers, with its sources.
//
//   1. Pick the facts that matter (pickFacts, no model, cheap): every fact line in the files the
//      asker may read is scored against the question's words, typos forgiven (one letter in a
//      word of 4+, two in a word of 8+); a file's name, aliases and description count too, so
//      "what do we know about Kai?" brings back Kai's whole file.
//   2. One small, cheap model call answers from those facts only, citing them by number.
//      Without a key, or when the call fails, the matching facts come back on their own.
// Answers are kept until anything in memory changes (store.js's memoryGeneration), so asking
// the same thing twice costs nothing. It only ever reads: nothing is written, sent or published.

import { callTool } from "./extract.js";
import { listFiles, memoryGeneration } from "./store.js";

const MAX_FACTS = 20;
const PER_FILE = 8;
const KEEP_MS = 6 * 60 * 60_000;
const answers = new Map();

const STOP = new Set(
  "the and for are was were what who whom whose which when where why how does did done has have had with that this these those from into about any all our your their they them there here not but can could would should will just than then also its is am be been being of to in on at by an as or if do me my we us you he she his her him it know known tell say said get got like want much many".split(" ")
);

// The words that matter in a piece of text, lower case
export function tokens(text) {
  return (String(text || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((w) => !STOP.has(w));
}
// A word cut to its stem ("sessions" → "session", "evenings" → "even")
export const stem = (w) => (w.length > 4 ? w.replace(/(?:ings|ing|ers|ies|es|ed|ly|s)$/, "") : w);
// The same word as typed, or the same stem ("evenings" and "evening")
export const alike = (a, b) => near(a, b) || near(stem(a), stem(b));

// Close enough? The same word, the start of a longer one ("eve" → "evening" needs 4+ letters),
// or a typo or two away (letters swapped, missing, extra or wrong)
export function near(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.startsWith(a)) return true;
  const longer = Math.max(a.length, b.length);
  const max = longer >= 8 ? 2 : longer >= 4 && a.length >= 3 ? 1 : 0;
  if (!max || Math.abs(a.length - b.length) > max) return false;
  // Edit distance (with swaps), giving up as soon as it's too far
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length] <= max;
}

const FACT = /^- \[(stated|observed|inferred)\] (.+)$/;

// The facts that best answer a question: [{ scope, owner_id, path, name, tag, fact, score }], best first
// files: the listing with bodies (listFiles withBody), only what the asker may read
export function pickFacts(files, question, max = MAX_FACTS) {
  const want = [...new Set(tokens(question))];
  if (!want.length) return [];
  const found = [];
  for (const f of files) {
    const head = tokens([f.name, f.description, String(f.path || "").replace(/\//g, " "), ...(f.aliases || []), f.owner_id].join(" "));
    const about = want.filter((w) => head.some((h) => alike(w, h))).length;
    const lines = [];
    for (const line of String(f.body || "").split("\n")) {
      const m = line.match(FACT);
      if (!m) continue;
      const have = tokens(m[2]);
      const hits = want.filter((w) => have.some((h) => alike(w, h))).length;
      if (!hits && !about) continue;
      lines.push({ scope: f.scope, owner_id: f.owner_id || null, path: f.path, name: f.name || f.path, tag: m[1], fact: m[2], score: hits * 2 + about, at: f.updated_at || 0 });
    }
    lines.sort((a, b) => b.score - a.score);
    found.push(...lines.slice(0, PER_FILE));
  }
  return found
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, max)
    .map(({ at, ...rest }) => rest);
}

const RULES = `You answer questions about what Nova Agent's memory (Index) knows, for the team at Novacane Studios (a recording studio in Forest Hill, London).
- Use ONLY the numbered facts. Never add anything they don't say, and never guess.
- If they don't answer the question, say plainly that Index doesn't remember that yet.
- Plain, warm British English. At most 3 short sentences.
- Cite the facts you used inline by number, like [2].`;

// readers: [{ scope, owner_id? }] what the asker may read (owner_id left out: every owner in that scope)
export async function askIndex(env, { q, readers }) {
  const question = String(q || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (question.length < 3) return { error: "Ask a question (a few words)", status: 400 };
  const key = JSON.stringify([memoryGeneration(), readers, question.toLowerCase()]);
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return { ...hit.value, cached: true };

  const files = [];
  for (const r of readers) files.push(...(await listFiles(env, { scopes: [r.scope], owner_id: r.owner_id, withBody: true })));
  const facts = pickFacts(files, question).map((f, i) => ({ n: i + 1, ...f }));
  let value;
  if (!facts.length) value = { answer: null, facts: [], used: [], ai: false, note: "Index doesn't remember anything about that yet." };
  else if (!env.ANTHROPIC_API_KEY) value = { answer: null, facts, used: [], ai: false, note: "Here's what Index remembers that matches." };
  else {
    try {
      const input = await callTool(env, {
        system: RULES,
        prompt: `Question: ${question}\n\nFacts:\n${facts.map((f) => `[${f.n}] (${f.name}) ${f.fact}`).join("\n")}`,
        tool: {
          name: "answer",
          description: "Answer the question from the facts.",
          input_schema: {
            type: "object",
            properties: {
              answer: { type: "string", description: "The answer, citing facts like [2]" },
              used: { type: "array", items: { type: "integer" }, description: "The numbers of the facts used" },
            },
            required: ["answer", "used"],
          },
        },
      });
      const answer = input && typeof input.answer === "string" ? input.answer.trim().slice(0, 1200) : "";
      const used = (input && Array.isArray(input.used) ? input.used : []).map(Number).filter((n) => facts.some((f) => f.n === n));
      value = answer ? { answer, facts, used, ai: true } : { answer: null, facts, used: [], ai: false, note: "Here's what Index remembers that matches." };
    } catch (err) {
      console.log("Ask Index failed:", err.message);
      // Not kept: next time it tries the model again
      return { answer: null, facts, used: [], ai: false, note: "The AI couldn't be reached, so here's what Index remembers that matches." };
    }
  }
  answers.set(key, { at: Date.now(), value });
  if (answers.size > 200) answers.delete(answers.keys().next().value);
  return value;
}
