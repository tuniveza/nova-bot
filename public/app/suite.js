// The Nova suite sheet: tap the Nova Hub brand at the top to see every app in the family.
// It stands on its own (nothing from app.js), so it works whatever the rest of the page is doing.
(() => {
  "use strict";

  // The brand (the button that opens it), the sheet, and its close button
  const brand = document.getElementById("brand");
  const sheet = document.getElementById("suite-sheet");
  const close = document.getElementById("suite-close");
  // Not on this page: nothing to do
  if (!brand || !sheet || !close) return;

  // Open the sheet, and move the keyboard focus into it
  function open() {
    sheet.hidden = false;
    brand.setAttribute("aria-expanded", "true");
    close.focus();
  }

  // Close the sheet, and hand the focus back to the brand
  function shut() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    brand.setAttribute("aria-expanded", "false");
    brand.focus();
  }

  brand.setAttribute("aria-expanded", "false");
  brand.addEventListener("click", open);
  close.addEventListener("click", shut);
  // A tap on the dimmed backdrop (not the card itself) closes it
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) shut();
  });
  // So does Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) shut();
  });

  // ===== All links: every live and testing address, from /app/api/links =====
  // Only fetched when the section is opened (Nova Hub's sign-in protects it).

  const toggle = document.getElementById("links-toggle");
  const body = document.getElementById("links-body");
  const groupsBox = document.getElementById("links-groups");
  const checked = document.getElementById("links-checked");
  const recheck = document.getElementById("links-recheck");
  if (!toggle || !body || !groupsBox || !checked || !recheck) return;

  // What each kind of address is called
  const KINDS = { live: "Live", machine: "Used by the apps", testing: "Testing", local: "Studio computer", planned: "Not set up yet" };
  // How each check result looks
  const STATES = { up: ["●", "Up"], down: ["✕", "Down"], unchecked: ["○", "Not checked"] };
  let loaded = false;

  // A small element with a class and some text
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== "") node.textContent = String(text);
    return node;
  }

  // Copy text, then say so on the button for a moment
  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch (err) {
      button.textContent = "Can't copy";
    }
    setTimeout(() => (button.textContent = "Copy"), 1600);
  }

  // One address: name, kind and state, a note, then the link (or the text with a copy button)
  function itemRow(item) {
    const li = make("li", "link-item");
    const top = make("div", "link-top");
    const kind = KINDS[item.kind] ? item.kind : "live";
    top.append(make("strong", "link-name", item.name), make("span", "link-kind " + kind, KINDS[kind]));
    const check = item.check || { state: "unchecked" };
    const state = STATES[check.state] ? check.state : "unchecked";
    const status = make("span", "link-state " + state);
    status.append(make("b", "", STATES[state][0]), document.createTextNode(" " + (check.label || STATES[state][1])));
    top.appendChild(status);
    li.appendChild(top);
    if (item.note) li.appendChild(make("p", "link-note", item.note));
    const url = String(item.url || "");
    const row = make("div", "link-url");
    if (/^https?:\/\//i.test(url) && item.kind !== "machine") {
      const a = make("a", "", url);
      Object.assign(a, { href: url, target: "_blank", rel: "noopener" });
      row.appendChild(a);
    } else if (url) {
      row.appendChild(make("code", "", url));
      const b = make("button", "link-copy", "Copy");
      b.type = "button";
      b.addEventListener("click", () => copy(url, b));
      row.appendChild(b);
    }
    if (url) li.appendChild(row);
    return li;
  }

  // One group, as a section that opens and closes
  function groupBlock(group, i) {
    const box = make("details", "links-group");
    if (i === 0) box.open = true;
    const items = group.items || [];
    const summary = make("summary", "");
    summary.append(make("span", "links-group-title", group.title || "Links"), make("span", "links-count", items.length));
    box.appendChild(summary);
    if (group.note) box.appendChild(make("p", "links-group-note", group.note));
    const list = make("ul", "links-list");
    list.append(...items.map(itemRow));
    box.appendChild(list);
    return box;
  }

  // Show a message in place of the list
  function message(text) {
    groupsBox.replaceChildren(make("p", "links-message", text));
  }

  // Fetch the list (fresh = ask for the addresses to be checked again)
  async function load(fresh) {
    recheck.disabled = true;
    checked.textContent = fresh ? "Checking…" : "Loading…";
    try {
      const res = await fetch("/app/api/links" + (fresh ? "?recheck=1" : ""), { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) {
        checked.textContent = "";
        return message("Sign in to Nova Hub to see the links.");
      }
      if (!res.ok) throw new Error("Couldn't load the links (" + res.status + ")");
      const data = await res.json();
      const groups = data.groups || [];
      loaded = true;
      const at = data.checkedAt ? new Date(data.checkedAt) : null;
      checked.textContent = at && !isNaN(at) ? "Checked " + at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "Not checked yet";
      if (!groups.length) return message("No links yet.");
      groupsBox.replaceChildren(...groups.map(groupBlock));
    } catch (err) {
      checked.textContent = "";
      message(err.message || "Couldn't load the links.");
    } finally {
      recheck.disabled = false;
    }
  }

  // Open or close the section (fetching the first time it opens)
  toggle.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open && !loaded) load(false);
  });
  recheck.addEventListener("click", () => load(true));
})();
