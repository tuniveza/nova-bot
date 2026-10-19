// Clients ⇄ Google Contacts, both ways, under a "Novacane clients" label (Portal → Admin → Google)
//
//   Nova → Google   every client (name, email, phone) is a Google contact with the label. One
//                   already in Google with the same email is linked, not made again.
//   Google → Nova   a contact given the label in Google becomes a client (or is linked to the
//                   client with the same email or phone); a change to a linked contact's name,
//                   email or phone in Google is made in Nova too, if it's later than Nova's.
//   Never           marketing consent: that stays Nova's alone (UK GDPR: recorded with its date and
//                   source), and nothing about it goes to Google. A contact deleted in Google is just
//                   unlinked: the client, their sessions and money stay.
//
// google_links 'contact': client id ⇄ the contact's resourceName (with its etag, and a hash of
// what was last synced). Google's sync token keeps the reading to what changed.

import { google } from "../nova/google.js";
import { cleanEmail, phoneKey } from "../clients.js";
import { flush, forgetLink, keepLink, later, linkFor, linkOf, links, low, prep, readSetting, sha, spendDb, writeSetting } from "./common.js";

const PEOPLE = "https://people.googleapis.com/v1";
const GROUP_KEY = "google_contacts_group";
const PULL_AT_KEY = "google_contacts_pull_at";
const PUSHED_KEY = "google_contacts_pushed_at";
const FIELDS = "names,emailAddresses,phoneNumbers,memberships,metadata";

const nowIso = () => new Date().toISOString();

// The three things that are kept in step
export const contactHash = (c) => sha(JSON.stringify([String(c.name || "").trim(), cleanEmail(c.email) || "", String(c.phone || "").trim()]));

// A Google person -> { name, email, phone } (the first of each)
export function personFields(p) {
  const name = (p.names || [])[0];
  return {
    name: String(name?.unstructuredName || name?.displayName || [name?.givenName, name?.familyName].filter(Boolean).join(" ") || "").replace(/\s+/g, " ").trim().slice(0, 100),
    email: cleanEmail((p.emailAddresses || [])[0]?.value || ""),
    phone: String((p.phoneNumbers || [])[0]?.value || "").trim().slice(0, 40) || null,
  };
}

// A client as a Google person (what's sent)
export function personBody(client, group) {
  const parts = String(client.name || "").trim().split(/\s+/);
  const body = {
    names: [{ givenName: parts[0] || client.name, familyName: parts.slice(1).join(" ") || undefined, unstructuredName: client.name }],
    emailAddresses: client.email ? [{ value: client.email }] : [],
    phoneNumbers: client.phone ? [{ value: client.phone }] : [],
  };
  if (group) body.memberships = [{ contactGroupMembership: { contactGroupResourceName: group } }];
  return body;
}

async function labelGroup(env, budget) {
  const saved = await readSetting(env, GROUP_KEY);
  if (saved) return saved;
  budget.left--;
  // One may be there already (connected before, or made by hand)
  const list = await google(env, "GET", `${PEOPLE}/contactGroups?pageSize=200`);
  const found = (list.contactGroups || []).find((g) => g.name === "Novacane clients" && g.groupType === "USER_CONTACT_GROUP");
  let resourceName = found?.resourceName;
  if (!resourceName) {
    budget.left--;
    resourceName = (await google(env, "POST", `${PEOPLE}/contactGroups`, { contactGroup: { name: "Novacane clients" } })).resourceName;
  }
  await writeSetting(env, GROUP_KEY, resourceName).run();
  return resourceName;
}

// ===== WHAT NOVA HAS =====

// Every client, read once a run (a studio has hundreds at most): by id, by email, by phone
async function clientMaps(env, budget) {
  if (budget.clients) return budget.clients;
  spendDb(budget);
  const { results } = await env.DB.prepare("SELECT id, name, email, phone, phone_key, updated_at FROM clients").all();
  const byId = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  for (const c of results) {
    byId.set(String(c.id), c);
    if (c.email) byEmail.set(c.email, c);
    if (c.phone_key) byPhone.set(c.phone_key, c);
  }
  budget.clients = { byId, byEmail, byPhone, all: results };
  return budget.clients;
}

// ===== GOOGLE → NOVA =====
//
// Only the studio's contacts are read: those with the label, and those already linked. Google is
// asked for the label's members (one call), then for those people in batches of 200 (people:
// batchGet), and only the ones whose etag changed are looked at. (Reading the whole Google account
// page by page went over the free plan's limits on a big account.)

const BATCH = 200;

export async function pullContacts(env, budget, group) {
  prep(budget);
  const L = await links(env, budget, "contact");
  budget.left--;
  const g = await google(env, "GET", `${PEOPLE}/${group}?maxMembers=5000`);
  const wanted = [...new Set([...(g.memberResourceNames || []), ...L.byGoogle.keys()])].sort();
  // Where the last run stopped (big lists take a few runs)
  const from = Math.max(0, Number(await readSetting(env, PULL_AT_KEY)) || 0);
  let at = from < wanted.length ? from : 0;
  let changed = 0;
  while (at < wanted.length) {
    if (low(budget, 3)) break;
    const names = wanted.slice(at, at + BATCH);
    budget.left--;
    const params = new URLSearchParams({ personFields: FIELDS });
    for (const n of names) params.append("resourceNames", n);
    const data = await google(env, "GET", `${PEOPLE}/people:batchGet?${params}`);
    for (const r of data.responses || []) {
      const name = r.requestedResourceName || r.person?.resourceName;
      const linked = L.byGoogle.get(String(name)) || null;
      // Deleted in Google: just unlinked (the client, their sessions and money stay)
      if (!r.person || r.status?.code === 5 || r.person.metadata?.deleted) {
        if (linked) forgetLink(env, budget, "contact", linked.nova_id);
        continue;
      }
      if (linked && linked.extra === r.person.etag) continue;
      changed += await takePerson(env, r.person, group, budget);
    }
    at += names.length;
  }
  const done = at >= wanted.length;
  later(budget, writeSetting(env, PULL_AT_KEY, done ? 0 : at));
  return { changed, more: !done };
}

// One contact from Google. Returns 1 if a client changed or was added.
export async function takePerson(env, p, group, budget = prep({ left: 0 })) {
  const link = await linkFor(env, budget, "contact", p.resourceName);
  const inGroup = (p.memberships || []).some((m) => m.contactGroupMembership?.contactGroupResourceName === group);
  if (!link && !inGroup) return 0;
  const f = personFields(p);
  if (!f.name && !f.email) return 0;
  const hash = await contactHash(f);
  const now = nowIso();
  const clients = await clientMaps(env, budget);
  if (link) {
    if (link.hash === hash) {
      if (link.extra !== p.etag) keepLink(env, budget, "contact", link.nova_id, p.resourceName, { extra: p.etag, hash });
      return 0;
    }
    const client = clients.byId.get(String(link.nova_id));
    if (!client) {
      forgetLink(env, budget, "contact", link.nova_id);
      return 0;
    }
    // Nova changed it later than Google: Nova's goes out (pushContacts), not this
    const googleAt = (p.metadata?.sources || []).map((s) => s.updateTime).filter(Boolean).sort().pop() || now;
    if (client.updated_at > googleAt) return 0;
    // That email is another client's already: leave both as they are
    const email = f.email ?? client.email;
    const other = email ? clients.byEmail.get(email) : null;
    if (other && String(other.id) !== String(client.id)) return 0;
    const phone = f.phone ?? client.phone;
    later(
      budget,
      env.DB.prepare("UPDATE clients SET name = ?, email = ?, phone = ?, phone_key = ?, updated_at = ?, updated_by = 'google' WHERE id = ?").bind(f.name || client.name, email, phone, phoneKey(phone), now, client.id)
    );
    Object.assign(client, { name: f.name || client.name, email, phone, phone_key: phoneKey(phone), updated_at: now });
    keepLink(env, budget, "contact", client.id, p.resourceName, { extra: p.etag, hash });
    return 1;
  }
  // Labelled in Google, not linked yet: the same person in Nova (email, then phone), or a new client
  const key = phoneKey(f.phone);
  const client = (f.email && clients.byEmail.get(f.email)) || (key && clients.byPhone.get(key)) || null;
  if (client) {
    if (await linkOf(env, budget, "contact", client.id)) return 0; // already linked to another contact: leave it
    keepLink(env, budget, "contact", client.id, p.resourceName, { extra: p.etag, hash: await contactHash(client) });
    return 0;
  }
  spendDb(budget);
  const row = await env.DB.prepare(
    "INSERT INTO clients (name, email, phone, phone_key, source, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 'import', ?, ?, 'google') RETURNING id"
  )
    .bind(f.name || f.email, f.email, f.phone, key, now, now)
    .first();
  const made = { id: row.id, name: f.name || f.email, email: f.email, phone: f.phone, phone_key: key, updated_at: now };
  clients.byId.set(String(row.id), made);
  if (f.email) clients.byEmail.set(f.email, made);
  if (key) clients.byPhone.set(key, made);
  keepLink(env, budget, "contact", row.id, p.resourceName, { extra: p.etag, hash });
  return 1;
}

// ===== NOVA → GOOGLE =====

// Clients new to Google, or changed since: a few each run (each new one is two calls to Google)
const PUSH_PER_RUN = 15;

export async function pushContacts(env, budget, group) {
  prep(budget);
  const L = await links(env, budget, "contact");
  const clients = await clientMaps(env, budget);
  const since = (await readSetting(env, PUSHED_KEY)) || "";
  // Not in Google yet, or changed since last time; oldest change first
  const todo = clients.all
    .filter((c) => !L.byNova.has(String(c.id)) || c.updated_at > since)
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  let done = 0;
  let reached = since;
  let stopped = false;
  for (const c of todo) {
    if (done >= PUSH_PER_RUN || low(budget, 3)) {
      stopped = true;
      break;
    }
    const hash = await contactHash(c);
    const link = L.byNova.get(String(c.id)) || null;
    if (link && link.hash === hash) {
      if (c.updated_at > reached) reached = c.updated_at;
      continue;
    }
    if (link) {
      budget.left--;
      let etag = link.extra;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const updated = await google(env, "PATCH", `${PEOPLE}/${link.google_id}:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers`, { ...personBody(c), etag });
          keepLink(env, budget, "contact", c.id, link.google_id, { extra: updated.etag, hash });
          break;
        } catch (err) {
          if (err.status === 404) {
            // Deleted in Google: made again with the label next time
            forgetLink(env, budget, "contact", c.id);
            break;
          }
          if (err.status !== 400 || attempt) throw err;
          // Someone changed it in Google meanwhile: get its new etag and try once more
          budget.left--;
          etag = (await google(env, "GET", `${PEOPLE}/${link.google_id}?personFields=metadata`)).etag;
        }
      }
    } else {
      // The same person may be in Google already: link them (and give them the label) instead
      let existing = null;
      if (c.email) {
        budget.left--;
        const found = await google(env, "GET", `${PEOPLE}/people:searchContacts?${new URLSearchParams({ query: c.email, readMask: "emailAddresses,memberships,names" })}`);
        existing = (found.results || []).map((r) => r.person).find((p) => (p.emailAddresses || []).some((e) => cleanEmail(e.value) === c.email));
      }
      if (existing && L.byGoogle.has(existing.resourceName)) existing = null; // linked to another client: make a new one
      if (existing) {
        if (!(existing.memberships || []).some((m) => m.contactGroupMembership?.contactGroupResourceName === group)) {
          budget.left--;
          await google(env, "POST", `${PEOPLE}/${group}/members:modify`, { resourceNamesToAdd: [existing.resourceName] });
        }
        keepLink(env, budget, "contact", c.id, existing.resourceName, { extra: existing.etag, hash: await contactHash(personFields(existing)) });
      } else {
        budget.left--;
        const made = await google(env, "POST", `${PEOPLE}/people:createContact?personFields=metadata`, personBody(c, group));
        keepLink(env, budget, "contact", c.id, made.resourceName, { extra: made.etag, hash });
      }
    }
    done++;
    if (c.updated_at > reached) reached = c.updated_at;
  }
  // (only moves on past changes that were all sent; new clients are found by "not linked yet")
  if (reached !== since && !stopped) later(budget, writeSetting(env, PUSHED_KEY, reached));
  return { done, more: stopped };
}

// ===== ONE RUN =====

export async function syncContacts(env, budget) {
  prep(budget);
  try {
    const group = await labelGroup(env, budget);
    const pulled = await pullContacts(env, budget, group);
    const pushed = await pushContacts(env, budget, group);
    await flush(env, budget);
    const L = await links(env, budget, "contact");
    const total = (await clientMaps(env, budget)).all.length;
    const linked = [...L.byNova.keys()].filter((id) => (budget.clients?.byId || new Map()).has(id)).length;
    const more = pulled.more || pushed.more || linked < total;
    const moved = pulled.changed + pushed.done;
    const note = more
      ? `Contacts: ${linked} of ${total} client${total === 1 ? "" : "s"} in Google so far · the rest next run`
      : `${linked} client${linked === 1 ? "" : "s"} in Google Contacts${moved ? ` (${pulled.changed} in, ${pushed.done} out just now)` : ""}`;
    return { note, more };
  } finally {
    await flush(env, budget).catch(() => {});
  }
}

// For Agent's google_contacts_find: names, emails and phones matching what's typed
export async function findContacts(env, query) {
  const found = await google(env, "GET", `${PEOPLE}/people:searchContacts?${new URLSearchParams({ query: String(query || "").slice(0, 100), readMask: "names,emailAddresses,phoneNumbers", pageSize: "10" })}`);
  return (found.results || []).map((r) => personFields(r.person));
}

// Import from contacts (Portal, 19 Oct 2026): the studio's Google Contacts searched by a phone number,
// each match with everything on its card, to add as a client (nothing is added here).
// Google matches numbers as they're written, so the number is tried the ways it may be kept (as typed,
// digits only, 07…, +44…), and only contacts with that number (its last 9 digits) are kept.
// -> [{ name, emails, phones, addresses, organisation, birthday, notes }]
const CARD_FIELDS = "names,emailAddresses,phoneNumbers,addresses,organizations,birthdays,biographies";
const lastNine = (value) => String(value || "").replace(/\D/g, "").slice(-9);
export function numberForms(phone) {
  const typed = String(phone || "").trim().slice(0, 40);
  const digits = typed.replace(/\D/g, "");
  const national = digits.startsWith("44") ? "0" + digits.slice(2) : digits.startsWith("0") ? digits : "";
  const forms = [typed, digits, national, national ? "+44" + national.slice(1) : "", national ? "+44 " + national.slice(1, 5) + " " + national.slice(5) : "", national ? national.slice(0, 5) + " " + national.slice(5) : ""];
  return [...new Set(forms.filter((f) => f.replace(/\D/g, "").length >= 6))];
}
export function contactCard(p) {
  const list = (items, of) => [...new Set((items || []).map(of).map((v) => String(v || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  const name = personFields(p).name;
  const org = (p.organizations || [])[0];
  const day = (p.birthdays || [])[0]?.date;
  return {
    name,
    emails: list(p.emailAddresses, (e) => cleanEmail(e.value || "")),
    phones: list(p.phoneNumbers, (t) => t.value),
    addresses: list(p.addresses, (a) => a.formattedValue || [a.streetAddress, a.city, a.postalCode, a.country].filter(Boolean).join(", ")),
    organisation: [org?.name, org?.title].filter(Boolean).join(", "),
    birthday: day && day.month && day.day ? [day.day, day.month, day.year].filter(Boolean).map((n, i) => (i < 2 ? String(n).padStart(2, "0") : n)).join("/") : "",
    notes: String((p.biographies || [])[0]?.value || "").trim().slice(0, 1000),
  };
}
export async function lookupByPhone(env, phone) {
  const want = lastNine(phone);
  if (want.length < 9) return [];
  const found = new Map();
  for (const query of numberForms(phone)) {
    const r = await google(env, "GET", `${PEOPLE}/people:searchContacts?${new URLSearchParams({ query, readMask: CARD_FIELDS, pageSize: "10" })}`);
    for (const { person } of r.results || []) if (person?.resourceName && (person.phoneNumbers || []).some((t) => lastNine(t.value) === want)) found.set(person.resourceName, person);
    if (found.size) break;
  }
  return [...found.values()].map(contactCard);
}
