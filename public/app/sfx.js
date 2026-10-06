// Nova suite sound effects: soft cosmic bells and sparkles for every tap, tab,
// switch, open, close, send, done and delete. Made live with the Web Audio API
// (no sound files), in D major pentatonic so everything sounds like one family,
// and kept quiet. The same file is used by every Nova suite app.
//
// Sounds play by themselves: one listener works out what kind of thing was
// pressed (a tab, a switch, a "send", a "delete"...). An element can choose its
// own sound with data-sfx="tap|tab|open|close|on|off|send|done|remove|error|message|none".
// Switched off and on with NovaSfx.setEnabled(false/true); remembered on the device.
//   window.NovaSfx = { play(name), enabled(), setEnabled(on), toggle() }
(() => {
  "use strict";
  if (window.NovaSfx) return;
  const KEY = "nova-sfx";
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  let out = null;
  let last = 0;

  // On unless switched off on this device
  function enabled() {
    try {
      return localStorage.getItem(KEY) !== "off";
    } catch (err) {
      return true;
    }
  }
  function setEnabled(on) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch (err) {}
    window.dispatchEvent(new CustomEvent("novasfxchange", { detail: { on: Boolean(on) } }));
    if (on) play("on");
    return Boolean(on);
  }

  // The sound maker, made on the first press (browsers only allow sound after one)
  function ready() {
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      // A gentle limiter, then the overall volume
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -18;
      limit.ratio.value = 6;
      out = ctx.createGain();
      out.gain.value = 0.9;
      limit.connect(out).connect(ctx.destination);
      out = limit;
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // One bell-like note: a sine with a soft triangle an octave up, a quick strike and a ringing tail
  function bell(freq, at, { gain = 0.08, length = 0.5, shimmer = 0.25, wave = "sine" } = {}) {
    const t = ctx.currentTime + at;
    for (const [f, g, w] of [[freq, gain, wave], [freq * 2, gain * shimmer, "triangle"]]) {
      if (!g) continue;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = w;
      osc.frequency.value = f;
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.exponentialRampToValueAtTime(g, t + 0.006);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
      osc.connect(amp).connect(out);
      osc.start(t);
      osc.stop(t + length + 0.05);
    }
  }

  // A soft breath of filtered noise (for opening and closing things)
  function whoosh(at, { from = 600, to = 2400, gain = 0.035, length = 0.28 } = {}) {
    const t = ctx.currentTime + at;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + length);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + length * 0.35);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(filter).connect(amp).connect(out);
    src.start(t);
    src.stop(t + length + 0.02);
  }

  // The notes (D major pentatonic, high and bright)
  const D6 = 1174.66, E6 = 1318.51, Fs6 = 1479.98, A6 = 1760, B6 = 1975.53, D7 = 2349.32, E7 = 2637.02, A5 = 880, D5 = 587.33;

  const SOUNDS = {
    // A light tap on anything
    tap: () => bell(A6, 0, { gain: 0.045, length: 0.18, shimmer: 0.15 }),
    // Switching tabs or views
    tab: () => { bell(E6, 0, { gain: 0.05, length: 0.22 }); bell(A6, 0.05, { gain: 0.045, length: 0.3 }); },
    // Opening a sheet, dialog, menu or section
    open: () => { whoosh(0, { from: 500, to: 2600 }); bell(D6, 0.02, { gain: 0.04, length: 0.35 }); bell(Fs6, 0.07, { gain: 0.04, length: 0.4 }); bell(A6, 0.12, { gain: 0.04, length: 0.5 }); },
    // Closing it again
    close: () => { whoosh(0, { from: 2400, to: 500, gain: 0.025, length: 0.22 }); bell(A6, 0, { gain: 0.035, length: 0.25 }); bell(E6, 0.06, { gain: 0.03, length: 0.3 }); },
    // A switch turned on / off
    on: () => { bell(Fs6, 0, { gain: 0.05, length: 0.2 }); bell(B6, 0.05, { gain: 0.05, length: 0.35 }); },
    off: () => { bell(B6, 0, { gain: 0.04, length: 0.18 }); bell(Fs6, 0.05, { gain: 0.035, length: 0.28 }); },
    // Sending a message or saving something
    send: () => { bell(D6, 0, { gain: 0.05, length: 0.25 }); bell(A6, 0.05, { gain: 0.05, length: 0.3 }); bell(D7, 0.1, { gain: 0.045, length: 0.55, shimmer: 0.4 }); },
    // Something finished: a sparkling run up
    done: () => [D6, Fs6, A6, D7, E7].forEach((f, i) => bell(f, i * 0.055, { gain: 0.045, length: 0.6, shimmer: 0.45 })),
    // Removing or deleting: a soft low drop
    remove: () => { bell(A5, 0, { gain: 0.06, length: 0.25, shimmer: 0 }); bell(D5, 0.07, { gain: 0.06, length: 0.4, shimmer: 0 }); },
    // Something went wrong: two low notes
    error: () => { bell(330, 0, { gain: 0.06, length: 0.22, shimmer: 0, wave: "triangle" }); bell(277, 0.12, { gain: 0.06, length: 0.35, shimmer: 0, wave: "triangle" }); },
    // A message arrived
    message: () => { bell(B6, 0, { gain: 0.04, length: 0.4 }); bell(E7, 0.08, { gain: 0.035, length: 0.6, shimmer: 0.4 }); },
  };

  function play(name) {
    if (!enabled() || !SOUNDS[name]) return;
    // Never a pile-up of sounds from one press
    const now = performance.now();
    if (now - last < 45) return;
    last = now;
    try {
      if (!ready()) return;
      SOUNDS[name]();
    } catch (err) {}
  }

  // Work out which sound a press should make
  const words = (el) => `${el.getAttribute("aria-label") || ""} ${el.title || ""} ${el.textContent || ""} ${el.className || ""} ${el.id || ""}`.toLowerCase();
  function soundFor(el) {
    const chosen = el.closest("[data-sfx]");
    if (chosen) return chosen.dataset.sfx;
    if (el.matches('input[type="checkbox"], input[type="radio"], [role="switch"]')) return el.checked || el.getAttribute("aria-checked") === "true" ? "on" : "off";
    if (el.matches('[role="tab"], .tab, .seg button, .chips .chip, [role="menuitemradio"]')) return "tab";
    if (el.matches("summary")) return el.parentElement && el.parentElement.open ? "close" : "open";
    const w = words(el);
    if (/\b(delete|remove|clear|discard|trash|unblock)\b|×|✕|card-delete/.test(w) && !/close/.test(w)) return "remove";
    if (/\bclose\b|cancel|dismiss|back\b/.test(w)) return "close";
    if (el.getAttribute("aria-haspopup") || /\bopen\b|menu|more|options|settings|suite|brand/.test(w)) return "open";
    if (/\b(done|finish|complete|✓|mark done|session done)\b/.test(w)) return "done";
    if (el.type === "submit" || /\b(send|save|add|plan|create|start|▶|sign in|book|export|copy)\b|primary|go\b/.test(w)) return "send";
    return "tap";
  }

  // Every press, anywhere (switches make their sound when they change, so they say on or off)
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target.closest('button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], summary, .chip, .tab, .theme-swatch');
      if (!el || el.disabled || el.matches('input[type="checkbox"], input[type="radio"]')) return;
      play(soundFor(el));
    },
    true
  );
  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (el.matches && el.matches('input[type="checkbox"], input[type="radio"]')) play(soundFor(el));
      else if (el.matches && el.matches("select")) play("tap");
    },
    true
  );

  window.NovaSfx = { play, enabled, setEnabled, toggle: () => setEnabled(!enabled()) };
})();
