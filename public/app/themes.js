// Nova Hub themes: puts the chosen theme on the page, remembers it on this device, and draws
// the theme picker (a swatch per theme) wherever the page has a <div id="theme-list">.
// Loaded in the <head>, before the page is drawn, so the right colours show from the very first
// frame (the site's security rules don't allow scripts written inside the page itself).
// Other pages on the site (the /admin pages) can load it too: window.NovaThemes = { list, current(), set(id) }.
(() => {
  "use strict";

  // The themes: their name, a little gradient to preview them, and the page colour (for the phone's status bar)
  const list = [
    { id: "cosmic", name: "Cosmic", color: "#06040D", preview: "radial-gradient(120% 90% at 20% 0%, #B01D68 0%, #25194D 55%, #06040D 100%), #06040D" },
    { id: "ember", name: "Ember", color: "#0B0505", preview: "radial-gradient(120% 90% at 20% 0%, #FF4D1F 0%, #8A1C0E 45%, #0B0505 100%), #0B0505" },
    { id: "aurora", name: "Aurora", color: "#030A0C", preview: "radial-gradient(120% 90% at 20% 0%, #3DF5B8 0%, #0B7A66 30%, #0B2A3A 65%, #030A0C 100%), #030A0C" },
    { id: "ocean", name: "Ocean", color: "#030713", preview: "radial-gradient(120% 90% at 20% 0%, #4CC9FF 0%, #1B5FD9 35%, #0D1B3D 70%, #030713 100%), #030713" },
    { id: "gold", name: "Gold", color: "#070605", preview: "radial-gradient(120% 90% at 20% 0%, #F0D08A 0%, #9C7A36 40%, #2B2316 70%, #070605 100%), #070605" },
    { id: "mono", name: "Mono", color: "#060607", preview: "radial-gradient(120% 90% at 20% 0%, #F2F2F5 0%, #6A6A74 35%, #1A1A20 70%, #060607 100%), #060607" },
  ];
  const KEY = "novahub-theme";
  const root = document.documentElement;

  // Find a theme by its id (or the default, Cosmic)
  function find(id) {
    return list.find((t) => t.id === id) || list[0];
  }

  // The theme saved on this device (or Cosmic)
  function saved() {
    try {
      return find(localStorage.getItem(KEY)).id;
    } catch (err) {
      return list[0].id;
    }
  }

  // Put a theme on the page: the colours, and the phone's status bar colour
  function apply(id) {
    const theme = find(id);
    root.setAttribute("data-theme", theme.id);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", theme.color));
    return theme.id;
  }

  // The theme on the page now
  function current() {
    return find(root.getAttribute("data-theme")).id;
  }

  // Choose a theme: fade across to it, remember it, and tell anyone listening
  function set(id) {
    const theme = find(id);
    try {
      localStorage.setItem(KEY, theme.id);
    } catch (err) {}
    const still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A smooth cross-fade where the browser can do it; otherwise it just changes
    if (document.startViewTransition && !still && theme.id !== current()) document.startViewTransition(() => apply(theme.id));
    else apply(theme.id);
    markSwatches(theme.id);
    window.dispatchEvent(new CustomEvent("novathemechange", { detail: { id: theme.id } }));
    return theme.id;
  }

  // Show which swatch is chosen
  function markSwatches(id) {
    document.querySelectorAll(".theme-swatch").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeId === id)));
  }

  // Draw the swatches into every theme list on the page
  function drawPicker() {
    document.querySelectorAll("#theme-list, [data-theme-list]").forEach((box) => {
      box.replaceChildren(
        ...list.map((t) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "theme-swatch";
          b.dataset.themeId = t.id;
          b.setAttribute("aria-label", t.name + " theme");
          const preview = document.createElement("span");
          preview.className = "theme-preview";
          preview.style.background = t.preview;
          const name = document.createElement("span");
          name.className = "theme-name";
          name.textContent = t.name;
          b.append(preview, name);
          b.addEventListener("click", () => set(t.id));
          return b;
        })
      );
    });
    markSwatches(current());
  }

  // Right now (before the page is drawn): the saved theme
  apply(saved());
  // Once the page is there: the picker
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", drawPicker);
  else drawPicker();
  // Changed in another tab or window: follow it
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      apply(e.newValue);
      markSwatches(current());
    }
  });

  window.NovaThemes = { list: list.map(({ id, name, preview }) => ({ id, name, preview })), current, set };
})();
