// The Options sheet: theme, text alignment and size, times, animations, the starfield,
// pings, music volume and the starting tab, plus Refresh and Sign out. Everything is saved
// on this device by window.NovaOptions (themes.js) and takes effect straight away.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const sheet = $("options-sheet");
  const opener = $("options-btn");
  if (!sheet || !opener || !window.NovaOptions) return;

  // Show the saved choices on the controls
  function show() {
    const o = window.NovaOptions.get();
    sheet.querySelectorAll(".chips[data-option]").forEach((group) => {
      group.querySelectorAll(".chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.value === String(o[group.dataset.option])));
    });
    sheet.querySelectorAll('input[type="checkbox"][data-option]').forEach((box) => (box.checked = o[box.dataset.option] !== false));
    sheet.querySelectorAll('input[type="range"][data-option]').forEach((range) => (range.value = o[range.dataset.option]));
  }

  // Open and close (like the Nova suite sheet)
  function open() {
    show();
    sheet.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    $("options-close").focus();
  }
  function close() {
    sheet.hidden = true;
    opener.setAttribute("aria-expanded", "false");
    opener.focus();
  }
  opener.addEventListener("click", open);
  $("options-close").addEventListener("click", close);
  // A tap on the dark backdrop closes it
  sheet.addEventListener("click", (e) => e.target === sheet && close());
  document.addEventListener("keydown", (e) => e.key === "Escape" && !sheet.hidden && close());

  // The choices
  sheet.querySelectorAll(".chips[data-option]").forEach((group) =>
    group.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      window.NovaOptions.set({ [group.dataset.option]: chip.dataset.value });
      show();
    })
  );
  sheet.querySelectorAll('input[type="checkbox"][data-option]').forEach((box) =>
    box.addEventListener("change", () => window.NovaOptions.set({ [box.dataset.option]: box.checked }))
  );
  sheet.querySelectorAll('input[type="range"][data-option]').forEach((range) =>
    range.addEventListener("input", () => {
      const o = window.NovaOptions.set({ [range.dataset.option]: Number(range.value) });
      // The music follows the slider as it moves
      if (range.dataset.option === "volume" && window.NovaAmbient) window.NovaAmbient.setVolume(o.volume / 100);
    })
  );
  $("options-reset").addEventListener("click", () => {
    window.NovaOptions.reset();
    if (window.NovaAmbient) window.NovaAmbient.setVolume(window.NovaOptions.defaults.volume / 100);
    show();
  });
  // Refresh and Sign out (handled by app.js) close the sheet first
  ["refresh", "logout"].forEach((id) => $(id) && $(id).addEventListener("click", close));

  // The music starts at the saved volume
  if (window.NovaAmbient) window.NovaAmbient.setVolume(window.NovaOptions.get().volume / 100);
})();
