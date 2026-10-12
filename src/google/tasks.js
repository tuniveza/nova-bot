// Quests ⇄ Google Tasks: a "Nova quests" list in the studio's Google Tasks (Portal → Admin → Google
// → "Quests in Google Tasks")
//
// Quests live on the studio PC (Nova Agent's planner). Every 10 minutes the PC sends its person's
// open and recently finished quests here (POST /nova-agent/google/tasks/sync), and this keeps the
// list in step:
//   Nova → Google   a new quest becomes a task (its title, a line about it, its due day); a change
//                   to it changes the task; a quest done in Nova is ticked off; a quest removed in
//                   Nova removes its task.
//   Google → Nova   a task ticked off in Google Tasks comes back as "done", and the PC marks the
//                   quest done. (Tasks added in Google by hand stay Google's: Nova doesn't make
//                   quests from them.)
// google_links 'task': quest id ⇄ task id, with a hash of what was last sent.
//
// A few writes a run (each is a call to Google); the rest go next time.

import { google } from "../nova/google.js";
import { flush, forgetLink, keepLink, links, low, prep, readSetting, sha, writeSetting, later } from "./common.js";

const TASKS = "https://tasks.googleapis.com/tasks/v1";
const LIST_KEY = "google_tasks_list";
const PULLED_KEY = "google_tasks_pulled_at";
const WRITES_PER_RUN = 15;
const MAX_QUESTS = 300;

// The "Nova quests" list (made once; again if it was deleted)
async function questList(env, budget) {
  const saved = await readSetting(env, LIST_KEY);
  if (saved) return saved;
  budget.left--;
  const lists = await google(env, "GET", `${TASKS}/users/@me/lists?maxResults=100`);
  let id = (lists.items || []).find((l) => l.title === "Nova quests")?.id;
  if (!id) {
    budget.left--;
    id = (await google(env, "POST", `${TASKS}/users/@me/lists`, { title: "Nova quests" })).id;
  }
  later(budget, writeSetting(env, LIST_KEY, id));
  return id;
}

// A quest from the PC, tidied: { id, title, notes, due ("YYYY-MM-DD" or null), done }
export function cleanQuest(q) {
  const id = String(q?.id || "").replace(/[^\w.:-]/g, "").slice(0, 80);
  if (!id) return null;
  const due = typeof q.due === "string" && /^\d{4}-\d{2}-\d{2}/.test(q.due) ? q.due.slice(0, 10) : null;
  return { id, title: String(q.title || "Quest").replace(/\s+/g, " ").trim().slice(0, 250), notes: String(q.notes || "").slice(0, 2000), due, done: q.done === true };
}

// A quest as a Google task
export function taskBody(q) {
  return { title: q.title, notes: q.notes || undefined, due: q.due ? `${q.due}T00:00:00.000Z` : undefined, status: q.done ? "completed" : "needsAction" };
}
const questHash = (q) => sha(JSON.stringify([q.title, q.notes, q.due, q.done]));

// One sync: the quests the PC sent (all of its person's open ones and the recently done ones).
// -> { completed: [quest ids ticked off in Google], unlinked: [ids whose task was deleted], note, more }
export async function syncTasks(env, budget, input) {
  prep(budget);
  try {
    const quests = (Array.isArray(input) ? input : []).slice(0, MAX_QUESTS).map(cleanQuest).filter(Boolean);
    const byId = new Map(quests.map((q) => [q.id, q]));
    const list = await questList(env, budget);
    const L = await links(env, budget, "task");
    const completed = [];
    const unlinked = [];

    // Google → Nova: tasks changed since last time (ticked off, or deleted)
    const since = await readSetting(env, PULLED_KEY);
    const startedAt = new Date().toISOString();
    let pageToken = "";
    let pulledAll = true;
    do {
      if (low(budget, 4)) {
        pulledAll = false;
        break;
      }
      budget.left--;
      const params = new URLSearchParams({ showCompleted: "true", showHidden: "true", showDeleted: "true", maxResults: "100" });
      if (since) params.set("updatedMin", since);
      if (pageToken) params.set("pageToken", pageToken);
      let data;
      try {
        data = await google(env, "GET", `${TASKS}/lists/${encodeURIComponent(list)}/tasks?${params}`);
      } catch (err) {
        // The list was deleted in Google: made again next run
        if (err.status === 404) {
          later(budget, writeSetting(env, LIST_KEY, ""));
          for (const l of [...L.byNova.values()]) forgetLink(env, budget, "task", l.nova_id);
          return { completed, unlinked: [...L.byNova.keys()], note: "The Nova quests list was gone in Google: it's made again next time.", more: true };
        }
        throw err;
      }
      for (const t of data.items || []) {
        const link = L.byGoogle.get(String(t.id));
        if (!link) continue;
        const q = byId.get(String(link.nova_id));
        if (t.deleted) {
          forgetLink(env, budget, "task", link.nova_id);
          unlinked.push(link.nova_id);
          continue;
        }
        if (t.status === "completed" && q && !q.done) {
          completed.push(q.id);
          q.done = true; // (so the push below doesn't undo it)
          keepLink(env, budget, "task", q.id, t.id, { extra: list, hash: await questHash(q) });
        }
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    if (pulledAll) later(budget, writeSetting(env, PULLED_KEY, startedAt));

    // Nova → Google: new and changed quests, a few each run
    let writes = 0;
    let more = !pulledAll;
    for (const q of quests) {
      if (writes >= WRITES_PER_RUN || low(budget, 2)) {
        more = true;
        break;
      }
      const link = L.byNova.get(q.id) || null;
      const hash = await questHash(q);
      if (link && link.hash === hash) continue;
      if (!link && q.done) continue; // finished before it ever went to Google: nothing to tick
      budget.left--;
      writes++;
      if (link) {
        try {
          await google(env, "PATCH", `${TASKS}/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(link.google_id)}`, taskBody(q));
          keepLink(env, budget, "task", q.id, link.google_id, { extra: list, hash });
        } catch (err) {
          if (err.status !== 404) throw err;
          forgetLink(env, budget, "task", q.id);
        }
      } else {
        const made = await google(env, "POST", `${TASKS}/lists/${encodeURIComponent(list)}/tasks`, taskBody(q));
        keepLink(env, budget, "task", q.id, made.id, { extra: list, hash });
      }
    }
    // Quests gone from Nova (removed): their tasks go
    for (const link of [...L.byNova.values()]) {
      if (byId.has(String(link.nova_id))) continue;
      if (writes >= WRITES_PER_RUN || low(budget, 2)) {
        more = true;
        break;
      }
      budget.left--;
      writes++;
      await google(env, "DELETE", `${TASKS}/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(link.google_id)}`).catch((err) => {
        if (err.status !== 404 && err.status !== 410) throw err;
      });
      forgetLink(env, budget, "task", link.nova_id);
    }
    await flush(env, budget);
    const n = (await links(env, budget, "task")).byNova.size;
    const note = `${n} quest${n === 1 ? "" : "s"} in Google Tasks${completed.length ? ` · ${completed.length} ticked off there` : ""}${more ? " · more next run" : ""}`;
    return { completed, unlinked, note, more };
  } finally {
    await flush(env, budget).catch(() => {});
  }
}

// For Agent's google_tasks_list: what's in the Nova quests list (and Google's own lists' open tasks)
export async function listTasks(env, { max = 30 } = {}) {
  const lists = await google(env, "GET", `${TASKS}/users/@me/lists?maxResults=20`);
  const out = [];
  for (const l of (lists.items || []).slice(0, 5)) {
    const data = await google(env, "GET", `${TASKS}/lists/${encodeURIComponent(l.id)}/tasks?${new URLSearchParams({ showCompleted: "false", maxResults: "50" })}`);
    for (const t of data.items || []) {
      out.push({ list: l.title, title: t.title || "(no title)", due: t.due ? t.due.slice(0, 10) : null, notes: String(t.notes || "").slice(0, 200) });
      if (out.length >= max) return out;
    }
  }
  return out;
}
