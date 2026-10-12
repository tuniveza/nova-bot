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
import { getLink, linkByGoogle, putLink, dropLink, readSetting, sha, writeSetting } from "./common.js";

const PEOPLE = "https://people.googleapis.com/v1";
const GROUP_KEY = "google_contacts_group";
const SYNC_KEY = "google_contacts_sync";
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

// ===== GOOGLE → NOVA =====

export async function pullContacts(env, budget, group) {
  let token = await readSetting(env, SYNC_KEY);
  let pageToken = "";
  let changed = 0;
  for (;;) {
    if (budget.left <= 2) break;
    const params = new URLSearchParams({ personFields: FIELDS, pageSize: "200", requestSyncToken: "true" });
    if (token) params.set("syncToken", token);
    if (pageToken) params.set("pageToken", pageToken);
    budget.left--;
    let data;
    try {
      data = await google(env, "GET", `${PEOPLE}/people/me/connections?${params}`);
    } catch (err) {
      // The sync token ran out (they last a week): read everything again
      if ((err.status === 400 || err.status === 410) && token) {
        token = "";
        await writeSetting(env, SYNC_KEY, "").run();
        continue;
      }
      throw err;
    }
    for (const p of data.connections || []) changed += await takePerson(env, p, group);
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      continue;
    }
    if (data.nextSyncToken) await writeSetting(env, SYNC_KEY, data.nextSyncToken).run();
    break;
  }
  return changed;
}

// One contact from Google. Returns 1 if a client changed or was added.
export async function takePerson(env, p, group) {
  const link = await linkByGoogle(env, "contact", p.resourceName);
  if (p.metadata?.deleted) {
    if (link) await dropLink(env, "contact", link.nova_id).run();
    return 0;
  }
  const inGroup = (p.memberships || []).some((m) => m.contactGroupMembership?.contactGroupResourceName === group);
  if (!link && !inGroup) return 0;
  const f = personFields(p);
  if (!f.name && !f.email) return 0;
  const hash = await contactHash(f);
  const now = nowIso();
  if (link) {
    if (link.hash === hash) {
      if (link.extra !== p.etag) await putLink(env, "contact", link.nova_id, p.resourceName, { extra: p.etag, hash }).run();
      return 0;
    }
    const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(Number(link.nova_id)).first();
    if (!client) {
      await dropLink(env, "contact", link.nova_id).run();
      return 0;
    }
    // Nova changed it later than Google: Nova's goes out (pushContacts), not this
    const googleAt = (p.metadata?.sources || []).map((s) => s.updateTime).filter(Boolean).sort().pop() || now;
    if (client.updated_at > googleAt) return 0;
    try {
      await env.DB.prepare("UPDATE clients SET name = ?, email = ?, phone = ?, phone_key = ?, updated_at = ?, updated_by = 'google' WHERE id = ?")
        .bind(f.name || client.name, f.email ?? client.email, f.phone ?? client.phone, phoneKey(f.phone ?? client.phone), now, client.id)
        .run();
    } catch {
      // That email is another client's already: leave both as they are
      return 0;
    }
    await putLink(env, "contact", client.id, p.resourceName, { extra: p.etag, hash }).run();
    return 1;
  }
  // Labelled in Google, not linked yet: the same person in Nova (email, then phone), or a new client
  const key = phoneKey(f.phone);
  let client = f.email ? await env.DB.prepare("SELECT * FROM clients WHERE email = ?").bind(f.email).first() : null;
  if (!client && key) client = await env.DB.prepare("SELECT * FROM clients WHERE phone_key = ?").bind(key).first();
  if (client) {
    const taken = await getLink(env, "contact", client.id);
    if (taken) return 0; // already linked to another contact: leave it
    await putLink(env, "contact", client.id, p.resourceName, { extra: p.etag, hash: await contactHash(client) }).run();
    return 0;
  }
  const row = await env.DB.prepare(
    "INSERT INTO clients (name, email, phone, phone_key, source, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 'import', ?, ?, 'google') RETURNING id"
  )
    .bind(f.name || f.email, f.email, f.phone, key, now, now)
    .first();
  await putLink(env, "contact", row.id, p.resourceName, { extra: p.etag, hash }).run();
  return 1;
}

// ===== NOVA → GOOGLE =====

export async function pushContacts(env, budget, group) {
  const since = (await readSetting(env, PUSHED_KEY)) || "";
  // Changed since last time, or never sent; oldest change first
  const { results } = await env.DB.prepare(
    `SELECT c.* FROM clients c LEFT JOIN google_links l ON l.kind = 'contact' AND l.nova_id = CAST(c.id AS TEXT)
     WHERE l.nova_id IS NULL OR c.updated_at > ? ORDER BY c.updated_at LIMIT 60`
  )
    .bind(since)
    .all();
  let done = 0;
  let reached = since;
  for (const c of results) {
    if (budget.left <= 3) break;
    const hash = await contactHash(c);
    const link = await getLink(env, "contact", c.id);
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
          await putLink(env, "contact", c.id, link.google_id, { extra: updated.etag, hash }).run();
          break;
        } catch (err) {
          if (err.status === 404) {
            // Deleted in Google: made again with the label next time
            await dropLink(env, "contact", c.id).run();
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
      if (existing) {
        if (!(existing.memberships || []).some((m) => m.contactGroupMembership?.contactGroupResourceName === group)) {
          budget.left--;
          await google(env, "POST", `${PEOPLE}/${group}/members:modify`, { resourceNamesToAdd: [existing.resourceName] });
        }
        await putLink(env, "contact", c.id, existing.resourceName, { extra: existing.etag, hash: await contactHash(personFields(existing)) }).run();
      } else {
        budget.left--;
        const made = await google(env, "POST", `${PEOPLE}/people:createContact?personFields=metadata`, personBody(c, group));
        await putLink(env, "contact", c.id, made.resourceName, { extra: made.etag, hash }).run();
      }
    }
    done++;
    if (c.updated_at > reached) reached = c.updated_at;
  }
  if (reached !== since) await writeSetting(env, PUSHED_KEY, reached).run();
  return done;
}

// ===== ONE RUN =====

export async function syncContacts(env, budget) {
  const group = await labelGroup(env, budget);
  const pulled = await pullContacts(env, budget, group);
  const pushed = await pushContacts(env, budget, group);
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM google_links WHERE kind = 'contact'").first();
  return `${n} client${n === 1 ? "" : "s"} in Google Contacts${pulled + pushed ? ` (${pulled} in, ${pushed} out just now)` : ""}`;
}

// For Agent's google_contacts_find: names, emails and phones matching what's typed
export async function findContacts(env, query) {
  const found = await google(env, "GET", `${PEOPLE}/people:searchContacts?${new URLSearchParams({ query: String(query || "").slice(0, 100), readMask: "names,emailAddresses,phoneNumbers", pageSize: "10" })}`);
  return (found.results || []).map((r) => personFields(r.person));
}
