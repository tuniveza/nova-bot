// Money in Google Sheets: one live sheet for the accountant (Portal → Money → "Open in Google
// Sheets"; Portal → Admin → Google → "Money in Google Sheets")
//
// "Nova Agent · Money" in the Nova Agent folder, with three tabs: Invoices, Payments and Expenses
// (the same rows as Money's CSV export: sent invoices, payments, confirmed expenses). It's brought
// up to date every hour, and straight away when someone presses "Open in Google Sheets". What's
// written is plain values (never run as formulas). Edits made in the sheet are overwritten: Money
// in Portal is where things change.

import { google } from "../nova/google.js";
import { exportRows } from "../money.js";
import { folder } from "./drive.js";
import { readSetting, sha, writeSetting } from "./common.js";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3";
const TABS = [
  ["invoices", "Invoices"],
  ["payments", "Payments"],
  ["expenses", "Expenses"],
];
const ALL = { from: "2000-01-01", to: "2099-12-31" };

async function makeSheet(env) {
  const made = await google(env, "POST", SHEETS, {
    properties: { title: "Nova Agent · Money", locale: "en_GB", timeZone: "Europe/London" },
    sheets: TABS.map(([, title]) => ({ properties: { title, gridProperties: { frozenRowCount: 1 } } })),
  });
  // Into the Nova Agent folder
  const parent = await folder(env, "root");
  await google(env, "PATCH", `${DRIVE}/files/${encodeURIComponent(made.spreadsheetId)}?addParents=${encodeURIComponent(parent)}&removeParents=root&fields=id`, {});
  await env.DB.batch([writeSetting(env, "google_sheet_id", made.spreadsheetId), writeSetting(env, "google_sheet_url", made.spreadsheetUrl), writeSetting(env, "google_sheet_hash", "")]);
  return made.spreadsheetId;
}

// Bring the sheet up to date (made the first time). force: write even if nothing changed.
// -> { url, written }
export async function refreshSheet(env, { force = false } = {}) {
  const data = [];
  for (const [what, title] of TABS) {
    const out = await exportRows(env, { what, ...ALL });
    data.push({ range: `'${title}'!A1`, values: out.rows || [] });
  }
  const hash = await sha(JSON.stringify(data));
  let id = await readSetting(env, "google_sheet_id");
  if (!id) id = await makeSheet(env);
  if (!force && hash === (await readSetting(env, "google_sheet_hash"))) return { url: await readSetting(env, "google_sheet_url"), written: false };
  try {
    await google(env, "POST", `${SHEETS}/${encodeURIComponent(id)}/values:batchClear`, { ranges: TABS.map(([, t]) => `'${t}'`) });
  } catch (err) {
    // Deleted in Drive: make a new one
    if (err.status !== 404) throw err;
    id = await makeSheet(env);
  }
  await google(env, "POST", `${SHEETS}/${encodeURIComponent(id)}/values:batchUpdate`, { valueInputOption: "RAW", data });
  await writeSetting(env, "google_sheet_hash", hash).run();
  return { url: await readSetting(env, "google_sheet_url"), written: true };
}

export async function sheetStatus(env) {
  const rows = [];
  for (const [what] of TABS) rows.push(Math.max(0, ((await exportRows(env, { what, ...ALL })).rows || []).length - 1));
  return `${rows[0]} invoices, ${rows[1]} payments, ${rows[2]} expenses in the sheet`;
}
