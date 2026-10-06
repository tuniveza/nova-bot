// Turning conversations into memory, off the critical path (never while someone waits).
//
//   1. Distil: one small, cheap model call reads a chunk of conversation and returns
//      only durable facts ({ path, tag, fact }), each one short line that would still be
//      true and useful in three months. No passing details, nothing that can be looked
//      up live (what's booked next Tuesday), no advice it made up, no card, bank or ID
//      numbers.
//   2. Merge, don't pile up: each file is rewritten with the new facts folded in (a line
//      on the same subject is replaced, not joined by a contradicting one), written with
//      its version token, and retried once if someone else wrote first.
//   3. Customers: facts about clients wait in the approval queue (Nova Index / Nova Hub)
//      instead of being saved straight away.
// Files that grow past MAX_FILE_BYTES are condensed in the same pass.

import { addPending, cleanPath, factLine, getFile, isForbidden, MAX_FILE_BYTES, putFile, TAGS } from "./store.js";

const MODEL = "claude-haiku-4-5";

async function callTool(env, { system, prompt, tool }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const call = (data.content || []).find((b) => b.type === "tool_use");
  return call ? call.input : null;
}

const DISTIL_RULES = `You keep the Nova suite's memory for Novacane Studios (a recording studio in Forest Hill, London). From the conversation, pull out only DURABLE facts worth remembering.

The test for every fact: "Would this still be true and useful in three months?" If not, leave it out.
- One short clause per fact, phrased to outlast specifics ("prefers evening sessions", not "booked Tuesday 7pm").
- Tag each: "stated" (they said it), "observed" (seen in what happened, e.g. what they booked), "inferred" (a clear pattern).
- Never: passing state, anything that can be looked up live (what's booked when, today's availability), advice or ideas the assistant came up with, small talk, or a log of what happened.
- Never keep card numbers, bank details, sort codes, account numbers, National Insurance or passport numbers, passwords, or health details.
- Most conversations hold nothing worth keeping: return an empty list then. Quality over quantity: at most 8 facts.
Where each fact goes (path):
PATHS`;

// 1. Distil: the durable facts in a transcript ("Customer: ...\nNovaBot: ..." lines)
export async function distil(env, { transcript, paths, who }) {
  if (!env.ANTHROPIC_API_KEY || !transcript.trim()) return [];
  const input = await callTool(env, {
    system: DISTIL_RULES.replace("PATHS", paths),
    prompt: `The conversation (${who}):\n"""\n${transcript.slice(-12000)}\n"""`,
    tool: {
      name: "save_facts",
      description: "Save the durable facts from the conversation (an empty list if there are none).",
      input_schema: {
        type: "object",
        properties: {
          facts: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Where it goes, e.g. profile, people/kai, topics/pricing, areas/ep-release, studio" },
                tag: { type: "string", enum: TAGS },
                fact: { type: "string", description: "One short clause" },
              },
              required: ["path", "tag", "fact"],
            },
          },
        },
        required: ["facts"],
      },
    },
  });
  return (input && Array.isArray(input.facts) ? input.facts : [])
    .map((f) => ({ path: cleanPath(f.path), tag: TAGS.includes(f.tag) ? f.tag : "stated", fact: String(f.fact || "").trim() }))
    .filter((f) => f.path && f.fact && !isForbidden(f.fact))
    .slice(0, 8);
}

// 2. Merge: fold new facts into a file, rewriting lines on the same subject; condense if it's grown big
async function mergeInto(env, { scope, owner_id, path, facts, source_app }) {
  const lines = facts.map((f) => factLine(f.tag, f.fact)).filter(Boolean);
  if (!lines.length) return { ok: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await getFile(env, scope, owner_id, path);
    let body;
    let description = current ? current.description : "";
    let aliases = current ? current.aliases : [];
    if (!current && lines.length) {
      body = lines.join("\n");
    } else {
      const big = (current.body.length + lines.join("\n").length) > MAX_FILE_BYTES;
      const out = env.ANTHROPIC_API_KEY
        ? await callTool(env, {
            system: `You maintain one memory file of one-line facts ("- [stated|observed|inferred] fact"). Merge the new facts in: when a new fact is about the same subject as an existing line, REWRITE that line (the newer fact wins, keep the most useful tag) instead of adding a second one; add genuinely new facts; keep every other line as it is. Never invent facts. Keep each line one short clause.${big ? ` The file is too big: also CONDENSE it, merging related lines, so the result is under ${Math.round(MAX_FILE_BYTES * 0.75)} characters.` : ""} Also give a one-line description of what the file holds and when to read it.`,
            prompt: `The file (${scope} · ${path}):\n${current.body || "(empty)"}\n\nNew facts:\n${lines.join("\n")}`,
            tool: {
              name: "write_file",
              description: "Write the merged file.",
              input_schema: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  aliases: { type: "array", items: { type: "string" }, description: "Other names this subject goes by (for people: nicknames, full names)" },
                  lines: { type: "array", items: { type: "string" }, description: 'Each "- [tag] fact"' },
                },
                required: ["description", "lines"],
              },
            },
          })
        : null;
      body = out && Array.isArray(out.lines) ? out.lines.join("\n") : [current.body, ...lines].filter(Boolean).join("\n");
      if (out && out.description) description = out.description;
      if (out && Array.isArray(out.aliases) && out.aliases.length) aliases = out.aliases;
    }
    if (!description) description = defaultDescription(path);
    const res = await putFile(env, { scope, owner_id, path, description, aliases, body, if_version: current ? current.version : "new" }, source_app);
    if (!res.conflict) return res;
  }
  return { error: "Couldn't save after a conflict" };
}

function defaultDescription(path) {
  if (path === "profile") return "Who they are: preferences, how they work and book";
  if (path === "studio") return "The studio: how it runs, rooms, people, policies";
  if (path === "public") return "Studio facts customers may be told";
  const [kind, name] = path.split("/");
  return kind === "people" ? `${name}: who they are and how they work with the studio` : kind === "topics" ? `${name}: what the studio knows about this` : `${name}: an ongoing piece of work`;
}

// The whole pass for one conversation chunk.
//   mode "auto": facts are saved straight away (staff and studio sources)
//   mode "pending": facts wait for approval (anything about customers)
export async function learn(env, { transcript, scope, owner_id, mode, source_app, source_ref, who, paths }) {
  const facts = await distil(env, { transcript, paths, who });
  if (!facts.length) return { facts: 0 };
  if (mode === "pending") {
    for (const f of facts) await addPending(env, { scope, owner_id, target: f.path, tag: f.tag, fact: f.fact, source_app, source_ref });
    return { facts: facts.length, pending: true };
  }
  // Group by file, then merge each file once
  const byFile = new Map();
  for (const f of facts) {
    // "studio" facts go to the studio's shared file; everything else to the caller's scope
    const target = f.path === "studio" || f.path === "public" ? { scope: "studio", owner_id: null, path: f.path } : { scope, owner_id, path: f.path };
    const key = `${target.scope}|${target.owner_id}|${target.path}`;
    if (!byFile.has(key)) byFile.set(key, { ...target, facts: [] });
    byFile.get(key).facts.push(f);
  }
  for (const target of byFile.values()) await mergeInto(env, { ...target, source_app });
  return { facts: facts.length, files: byFile.size };
}

// An approved pending fact goes into its file the same way (merged, never just appended)
export async function approve(env, row, editedFact) {
  const fact = String(editedFact || row.fact);
  if (isForbidden(fact)) return { error: "That can't be kept in memory" };
  return mergeInto(env, { scope: row.scope, owner_id: row.owner_id, path: row.target, facts: [{ tag: row.tag, fact }], source_app: "Nova Index" });
}

// Where facts may go, by source (shown to the model)
export const PATHS = {
  customer: `- "profile": about this client (preferences, what they work on, how they like to book)
- "people/<name>": someone else they mention who works with the studio (only if clearly durable)
- "topics/<subject>": a durable fact about a subject that matters to this client`,
  staff: `- "profile": about this staff member (how they work, their rhythm, preferences)
- "people/<name>": a client or collaborator they talk about (preferences, how they work)
- "topics/<subject>": a subject (pricing, gear, processes)
- "areas/<name>": an ongoing piece of work (e.g. areas/ep-release)
- "studio": a durable fact about how the studio runs`,
  hub: `- "people/<name>": a client or collaborator the team talks about (preferences, how they work)
- "topics/<subject>": a subject (pricing, gear, processes)
- "areas/<name>": an ongoing piece of work
- "studio": a durable fact about how the studio runs
- "public": a studio fact that customers may be told`,
};
