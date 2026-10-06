// NovaBot: the Novacane chat widget
// Adds the chat bubble and window to the page, sends messages to the Worker and
// shows replies. NovaBot can also listen (microphone) and talk back (speaker),
// using the Worker's free Cloudflare Workers AI allowance.
//
// On Squarespace it's loaded from the Worker with novabot.css (see
// README-SQUARESPACE.md). Optional attributes on the <script> tag:
//   data-worker="http://localhost:8787"  talk to a different Worker (testing)
//   data-closed                          start with the chat window closed
//                                        (it always starts closed on phones)

(function () {
  // Only set up once, even if the script is included twice
  if (document.getElementById("nv-chat-panel")) return;

  const script = document.currentScript || document.querySelector('script[src*="novabot.js"]');

  // ===== THINGS YOU CAN EDIT =====

  // The live Worker address
  const LIVE_WORKER_URL = "https://novacane-worker.novacane-studio.workers.dev";

  // The booking page (the "Book a session" button)
  const BOOKING_LINK = "https://novacane.co.uk/bookings-contact";

  // The privacy policy (linked under the message box)
  const PRIVACY_LINK = "https://novacane.co.uk/privacy-policy";

  // The speech bubble that pops up over the chat button when the chat starts
  // closed, and how long to wait (in milliseconds) before it appears
  const TEASER = "Hi! I can help you with booking, sessions, prices & more.";
  const TEASER_DELAY = 1500;

  // The chat window stays open until it's closed (the × or the chat button).
  // When it sits over any of these on the page, it moves out of the way so
  // they can be clicked: first to the other side of the screen, and if that's
  // in the way too, it shrinks down to its header bar (hover or tap it to open
  // it up again). It never moves while someone is typing in it, hovering over
  // it or using the mic. Set to "" to turn this off.
  const MOVE_AWAY_FROM = 'a[href], button, input, select, textarea, label, iframe, video, form, [role="button"]';

  // How long the page must be still (milliseconds) before it moves back to its
  // usual spot or opens back up by itself, so it doesn't jump around while
  // someone scrolls
  const COME_BACK_AFTER = 1500;

  // ===== THE CHAT'S HTML =====

  // Talk to the Worker this script was loaded from, unless told otherwise
  const scriptOrigin = script ? new URL(script.src, location.href).origin : "";
  const WORKER_URL =
    (script && script.dataset.worker) ||
    (/\.workers\.dev$|\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(scriptOrigin) ? scriptOrigin : LIVE_WORKER_URL);

  const widget = document.createElement("div");
  widget.id = "nv-chat";
  widget.innerHTML = `
    <button id="nv-chat-toggle" type="button" aria-label="Open chat with NovaBot" aria-controls="nv-chat-panel" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 5h16v11H9l-5 4z"/>
        <g class="nv-wave" fill="currentColor" stroke="none">
          <rect x="6.3" y="7.5" width="1.4" height="6" rx="0.7"/>
          <rect x="8.8" y="7.5" width="1.4" height="6" rx="0.7"/>
          <rect x="11.3" y="7.5" width="1.4" height="6" rx="0.7"/>
          <rect x="13.8" y="7.5" width="1.4" height="6" rx="0.7"/>
          <rect x="16.3" y="7.5" width="1.4" height="6" rx="0.7"/>
        </g>
      </svg>
    </button>

    <div id="nv-chat-teaser" hidden>
      <button class="nv-teaser-open" type="button" aria-controls="nv-chat-panel">
        <span class="nv-teaser-name">NovaBot</span>
        <span class="nv-teaser-text"></span>
      </button>
      <button class="nv-teaser-close" type="button" aria-label="Dismiss">×</button>
    </div>

    <div id="nv-chat-panel" role="dialog" aria-label="NovaBot, Novacane chat">
      <div class="nv-header">
        <div>
          <p class="nv-title">Novacane</p>
          <p class="nv-subtitle">Sessions, prices &amp; booking</p>
        </div>
        <button id="nv-chat-close" type="button" aria-label="Close chat">×</button>
      </div>

      <div id="nv-chat-messages"></div>

      <div class="nv-composer">
        <!-- The main action: opens the booking card in the chat (or the booking page) -->
        <a class="nv-book">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>
          </svg>
          <span>Book a session</span>
        </a>
        <div class="nv-input-row">
          <textarea id="nv-chat-input" rows="1" placeholder="Type or tap the mic…" maxlength="1000" autocomplete="off" aria-label="Message NovaBot"></textarea>
          <button id="nv-chat-send" type="button">
            <span>Send</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 12h15M13 6l6 6-6 6"/>
            </svg>
          </button>
        </div>
        <div class="nv-tools">
          <button id="nv-mic" class="nv-tool" type="button" aria-pressed="false" title="Speak to NovaBot" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>
            </svg>
            <span>Speak</span>
          </button>
          <button id="nv-voice-toggle" class="nv-tool" type="button" aria-pressed="false" title="Turn on voice replies" hidden>
            <svg class="nv-when-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>
            </svg>
            <svg class="nv-when-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>
            </svg>
            <span>Voice</span>
          </button>
          <button id="nv-sounds" class="nv-tool" type="button" aria-pressed="true" title="Turn the chat's sound effects off">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>
            </svg>
            <span>Sounds</span>
          </button>
          <button id="nv-feedback" class="nv-tool" type="button" title="Tell us how NovaBot could be better (type or speak)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 5h16v11H9l-5 4z"/><path d="M12 7.6l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z"/>
            </svg>
            <span>Feedback</span>
          </button>
        </div>
      </div>

      <div class="nv-foot">
        <button id="nv-keep-closed" type="button" role="switch" aria-checked="false" title="Keep the chat closed on every page until you switch this off">
          <span class="nv-switch" aria-hidden="true">
            <span class="nv-knob">
              <!-- The Novacane sigil: a broken ring cut by the slanted N -->
              <svg class="nv-sigil" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1">
                <g class="nv-sigil-ring">
                  <path d="M20.19 6.26A10 10 0 0 1 6.26 20.19"/>
                  <path d="M3.81 17.74A10 10 0 0 1 17.74 3.81"/>
                </g>
                <path class="nv-sigil-n" d="M3.9 20.1 11.3 7.5M12.5 8.3 13.5 16M14.7 16.5 20.1 3.9"/>
              </svg>
            </span>
          </span>
          <span class="nv-keep-label">Keep chat closed</span>
        </button>
        <p class="nv-privacy">Chats are saved for 90 days. <a>Privacy policy</a></p>
      </div>

      <!-- Shown while the Novacane track plays, just before the booking page opens -->
      <div class="nv-booking-moment" role="status" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" aria-hidden="true">
          <path d="M20.19 6.26A10 10 0 0 1 6.26 20.19"/>
          <path d="M3.81 17.74A10 10 0 0 1 17.74 3.81"/>
          <path d="M3.9 20.1 11.3 7.5M12.5 8.3 13.5 16M14.7 16.5 20.1 3.9"/>
        </svg>
        <p class="nv-moment-title">Let's make something special</p>
        <p class="nv-moment-sub">Taking you to booking…</p>
        <button class="nv-moment-go" type="button">Go now →</button>
      </div>
    </div>
  `;
  widget.querySelector(".nv-book").href = BOOKING_LINK;
  widget.querySelector(".nv-privacy a").href = PRIVACY_LINK;
  widget.querySelector(".nv-teaser-text").textContent = TEASER;
  document.body.appendChild(widget);

  // Find the HTML pieces
  const toggle = document.getElementById("nv-chat-toggle");
  const panel = document.getElementById("nv-chat-panel");

  // ===== Lite mode, for less powerful devices =====
  // Same look, but nothing that makes the device redraw constantly (see
  // "Lite mode" in novabot.css). On for Android phones and tablets, and on any
  // other device whose frame rate drops when the chat first opens (remembered).
  const LITE_KEY = "nv-lite";
  let liteRemembered = false;
  try {
    liteRemembered = localStorage.getItem(LITE_KEY) === "1";
  } catch (err) {}
  if (/Android/i.test(navigator.userAgent) || (navigator.deviceMemory && navigator.deviceMemory <= 4) || liteRemembered) widget.classList.add("nv-lite");
  let frameRateChecked = false;
  // Watch 60 frames once the chat is open: if they're slow, switch to lite
  function checkFrameRate() {
    if (frameRateChecked || document.hidden || widget.classList.contains("nv-lite")) return;
    frameRateChecked = true;
    const gaps = [];
    let last = performance.now();
    const tick = (now) => {
      // A long pause means the tab was hidden or switched away: that says
      // nothing about the device, so don't decide anything this time
      if (now - last > 250 || document.hidden) return (frameRateChecked = false);
      gaps.push(now - last);
      last = now;
      if (gaps.length < 60) return requestAnimationFrame(tick);
      gaps.sort((a, b) => a - b);
      const slowFrames = gaps.filter((gap) => gap > 34).length;
      if (gaps[30] > 20 || slowFrames > 8) {
        widget.classList.add("nv-lite");
        try {
          localStorage.setItem(LITE_KEY, "1");
        } catch (err) {}
      }
    };
    requestAnimationFrame(tick);
  }
  // The soft glow around the window, on its own layer just behind it (so the
  // graphics card can animate it without redrawing the whole chat each frame)
  const panelGlow = document.createElement("div");
  panelGlow.className = "nv-panel-glow";
  panelGlow.setAttribute("aria-hidden", "true");
  panel.after(panelGlow);
  const header = panel.querySelector(".nv-header");
  const soundsButton = document.getElementById("nv-sounds");
  const list = document.getElementById("nv-chat-messages");
  const input = document.getElementById("nv-chat-input");
  const send = document.getElementById("nv-chat-send");
  const close = document.getElementById("nv-chat-close"); // optional
  const voiceToggle = document.getElementById("nv-voice-toggle");
  const mic = document.getElementById("nv-mic");
  const teaser = document.getElementById("nv-chat-teaser");
  const keepClosedSwitch = document.getElementById("nv-keep-closed");

  // Same sizes as the "Phones: full screen chat" part of novabot.css
  const PHONE = "(max-width: 480px), (max-height: 560px)";
  // Phones and tablets: a finger, no mouse. The window stays where it is (no
  // moving out of the way or shrinking, which is for the mouse), it doesn't pop
  // the on-screen keyboard up by itself, and it starts closed like on phones.
  const TOUCH = "(hover: none) and (pointer: coarse)";
  const fingerOnly = () => matchMedia(TOUCH).matches;

  // ===== THE CHAT CARRIES OVER BETWEEN PAGES =====
  // Saved for this browser tab only (sessionStorage), so moving to another
  // page on the website keeps the conversation.

  function loadSaved() {
    try {
      return JSON.parse(sessionStorage.getItem("nv-chat")) || {};
    } catch (err) {
      return {};
    }
  }
  const saved = loadSaved();

  // Identifies this conversation in the studio's chat log
  const chatId =
    saved.chatId ||
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // The conversation so far (sent to the Worker each time)
  const history = Array.isArray(saved.history) ? saved.history : [];

  function saveChat() {
    const shown = [...list.children]
      .filter((div) => !div.classList.contains("nv-typing") && div.dataset.text)
      .map((div) => ({ text: div.dataset.text, who: div.classList.contains("nv-user") ? "user" : "bot" }));
    try {
      sessionStorage.setItem(
        "nv-chat",
        JSON.stringify({
          chatId,
          history: history.slice(-40), // the Worker reads the last 40 too
          shown: shown.slice(-60),
          closed: panel.classList.contains("nv-closed"),
        })
      );
    } catch (err) {}
  }

  // NovaBot's opening lines. One is picked at random each visit.
  const GREETINGS = [
    "Welcome to Novacane. I'm NovaBot. How can I help with your session?",
    "Yo, welcome to Novacane 🎙️ I'm NovaBot. What are we working on?",
    "NovaBot here. What can I help you with?",
    "Welcome to Novacane 🎙️ Recording, mixing, production or something else? NovaBot can point you in the right direction.",
    "Hey! NovaBot here 👋 What brings you to Novacane?",
    "Welcome to Novacane Studio. I'm NovaBot. Looking to book a session, check pricing or find out what we can do for your project?",
    "What's good? 🎙️ NovaBot here. You making music, recording vocals, mixing a track or planning something bigger?",
    "Yo, welcome to Novacane 🎙️ I'm NovaBot.\nWhat are we working on: recording, mixing, production, voiceover, studio hire or something else?",
  ];

  // Said when someone reopens the chat after already talking
  const WELCOME_BACK = [
    "Welcome back. What are we sorting out this time?",
    "Back again? Let's get this project moving.",
    "NovaBot's ready. What do you need?",
    "Alright, let's get back to it. What are you working on?",
  ];

  function pick(lines) {
    return lines[Math.floor(Math.random() * lines.length)];
  }

  // Is the chat window showing right now?
  function isShowing() {
    return getComputedStyle(panel).display !== "none";
  }

  // Open or close the chat window
  // Opening: it rises gently into place from the chat button. Closing: it
  // sinks back into the button (a little smaller, fading and softening), then
  // the button catches it with a burst of stardust and a ring of light. It
  // stays in its place throughout. Straight away for people who ask for less motion.
  const CLOSE_MS = 340;
  let closing = null;
  function foldAway() {
    if (calm) return panel.classList.add("nv-closed");
    panel.classList.add("nv-closing");
    sound.tuck();
    closing = setTimeout(() => {
      closing = null;
      panel.classList.remove("nv-closing");
      panel.classList.add("nv-closed");
      lockPage();
      // The chat button catches it
      toggle.classList.remove("nv-caught");
      void toggle.offsetWidth;
      toggle.classList.add("nv-caught");
      setTimeout(() => toggle.classList.remove("nv-caught"), 900);
      const b = toggle.getBoundingClientRect();
      sparkle(b.left + b.width / 2, b.top + b.height / 2, 16);
    }, CLOSE_MS);
  }

  function openClose() {
    unlockAudio();
    if (closing) return; // already folding away
    place("home", false);
    if (isShowing()) foldAway();
    else panel.classList.remove("nv-closed");
    const opening = !panel.classList.contains("nv-closed") && !panel.classList.contains("nv-closing");
    toggle.setAttribute("aria-expanded", opening ? "true" : "false");
    // A soft rising chime opening, falling closing
    if (opening) sound.open();
    else sound.close();
    if (opening) {
      hideTeaser();
      // Coming back after already chatting? Say welcome back.
      if (history.length > 0 && list.lastElementChild.dataset.welcome !== "yes") {
        addMessage(pick(WELCOME_BACK), "bot").dataset.welcome = "yes";
        saveChat();
      }
      // Ready to type, except on touch screens, where that would throw the
      // on-screen keyboard up over the chat before they've even looked at it
      if (!fingerOnly()) input.focus();
      if (panel.classList.contains("nv-booking")) startMusic(); // back to an open booking card
      requestAnimationFrame(measurePeaks);
      fitToScreen();
      lockPage();
      setTimeout(checkFrameRate, 700); // once it has finished opening
    } else {
      stopSpeaking();
      stopListening();
      stopMusic();
    }
    saveChat();
  }

  // ===== "KEEP CHAT CLOSED" SWITCH =====
  // When it's on, the chat stays closed on every page and every visit (no
  // opening by itself, no speech bubble) until it's switched off. The chat
  // button still opens it. Remembered in this browser (localStorage).

  function readKeepClosed() {
    try {
      return localStorage.getItem("nv-keep-closed") === "yes";
    } catch (err) {
      return false;
    }
  }

  let keepClosed = readKeepClosed();

  function setKeepClosed(on) {
    keepClosed = on;
    sound.slide(on);
    keepClosedSwitch.setAttribute("aria-checked", on ? "true" : "false");
    try {
      if (on) localStorage.setItem("nv-keep-closed", "yes");
      else localStorage.removeItem("nv-keep-closed");
    } catch (err) {}
    if (on) {
      hideTeaser();
      // Let the switch slide across, then close the chat
      setTimeout(() => {
        if (keepClosed && isShowing()) openClose();
      }, 350);
    }
  }

  // The little speech bubble above the chat button. Shown once per visit
  // while the chat is closed, until it's tapped, dismissed or the chat opens.
  function showTeaser() {
    let seen = null;
    try {
      seen = sessionStorage.getItem("nv-teaser-seen");
    } catch (err) {}
    if (seen || keepClosed || isShowing()) return;
    teaser.hidden = false;
    toggle.classList.add("nv-attention");
  }

  function hideTeaser() {
    if (teaser.hidden) return;
    teaser.hidden = true;
    toggle.classList.remove("nv-attention");
    try {
      sessionStorage.setItem("nv-teaser-seen", "yes");
    } catch (err) {}
  }

  // ===== THE CHAT BUTTON'S WAVEFORM =====
  // The bars in the chat button sway gently all the time. While music or
  // video plays on the page, or NovaBot is talking, they get busier. Where the
  // browser lets us hear the page's audio (files on this website), they follow
  // the actual sound. Muted videos (like background videos) don't count.

  const bars = toggle.querySelectorAll(".nv-wave rect");
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const playing = new Set(); // media playing out loud right now
  const hearing = new WeakSet(); // media whose sound we're following
  let ears = null; // { context, analyser, levels } once needed
  let waveFrame = null;

  // Bass to treble: which frequency slices each bar follows
  const BANDS = [[1, 3], [3, 8], [8, 16], [16, 32], [32, 64]];

  // Only same-website (or CORS-enabled) media can be listened to. Trying it on
  // anything else would silence it, so those just get the busier sway.
  function canHear(media) {
    if (media.crossOrigin !== null) return true;
    const src = media.currentSrc;
    if (!src) return false;
    if (/^(blob|data):/.test(src)) return true;
    try {
      return new URL(src, location.href).origin === location.origin;
    } catch (err) {
      return false;
    }
  }

  async function hear(media) {
    if (hearing.has(media)) return;
    try {
      if (!ears) {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        analyser.connect(context.destination);
        ears = { context, analyser, levels: new Uint8Array(analyser.frequencyBinCount) };
      }
      // Don't wait forever if the browser won't start audio yet
      await Promise.race([ears.context.resume(), new Promise((done) => setTimeout(done, 300))]);
      // Routing sound through audio that isn't running would mute it
      if (ears.context.state !== "running") return;
      ears.context.createMediaElementSource(media).connect(ears.analyser);
      hearing.add(media);
    } catch (err) {}
  }

  function mediaChanged(media) {
    if (media.paused || media.ended || media.muted || media.volume === 0) {
      playing.delete(media);
      updateWave();
      return;
    }
    playing.add(media);
    if (!calm && !widget.classList.contains("nv-lite") && canHear(media)) hear(media).then(updateWave);
    else updateWave();
  }

  function updateWave() {
    // (not in lite mode: following the sound redraws the button every frame)
    const live = !calm && !widget.classList.contains("nv-lite") && [...playing].some((media) => hearing.has(media));
    toggle.classList.toggle("nv-live", live);
    toggle.classList.toggle("nv-playing", playing.size > 0 && !live);
    if (live && !waveFrame) waveFrame = requestAnimationFrame(drawWave);
    if (!live && waveFrame) {
      cancelAnimationFrame(waveFrame);
      waveFrame = null;
    }
  }

  // Move the bars and glow with the sound, every frame
  function drawWave() {
    ears.analyser.getByteFrequencyData(ears.levels);
    let total = 0;
    bars.forEach((bar, i) => {
      const [from, to] = BANDS[i];
      let sum = 0;
      for (let k = from; k < to; k++) sum += ears.levels[k];
      const level = sum / (to - from) / 255;
      total += level;
      bar.style.setProperty("--nv-bar", (0.25 + 0.75 * level).toFixed(3));
    });
    toggle.style.setProperty("--nv-level", (total / bars.length).toFixed(3));
    waveFrame = requestAnimationFrame(drawWave);
  }

  // ===== SOUND EFFECTS =====
  // Quiet, ambient studio sounds made on the fly (no sound files): soft,
  // slow-blooming synth notes and breaths of air through a large, warm
  // reverb, like a dim studio at night. Nothing clicky or bleepy: every sound
  // fades in gently and lingers. Each thing has its own sound: opening and closing, each button,
  // sending, replies arriving, and letters, spaces and deleting while typing.
  // Everything is in G minor, so it all sounds good together. Browsers only
  // allow sound after the visitor has clicked or typed on the page, so the
  // first hover can be silent. The "Sounds" button turns them off
  // (remembered in this browser).

  let soundsOn = true;
  try {
    soundsOn = localStorage.getItem("nv-sounds") !== "off";
  } catch (err) {}
  let sfx = null; // the sound engine, started on the first click or key press
  let lastHover = 0;
  let lastKey = 0;

  // Notes (Hz) in G minor, used by every sound
  const N = {
    G2: 98, D3: 146.83, G3: 196, Bb3: 233.08, C4: 261.63, D4: 293.66, F4: 349.23, G4: 392, A4: 440,
    Bb4: 466.16, C5: 523.25, D5: 587.33, F5: 698.46, G5: 783.99, A5: 880, Bb5: 932.33, D6: 1174.66,
  };
  // The Novacane chords (G minor): bass note, pad notes, arpeggio notes.
  // Used by the booking track and the booking card's music.
  const NOVA_CHORDS = {
    Gm9: [49, [N.G3, N.Bb3, N.D4, N.F4, N.A4], [N.G4, N.Bb4, N.D5, N.F5, N.A5]],
    Ebmaj7: [38.89, [155.56, N.G3, N.Bb3, N.D4], [311.13, N.G4, N.Bb4, N.D5, N.G5]],
    F: [43.65, [174.61, 220, N.C4, 311.13], [N.F4, N.A4, N.C5, N.F5]],
    Cm9: [65.41, [130.81, 155.56, N.G3, N.Bb3, N.D4], [N.G4, N.Bb4, N.C5, N.D5, 622.25]],
    Bbmaj7: [58.27, [116.54, N.D3, 174.61, 220], [N.Bb4, N.D5, N.F5, N.A5]],
    D: [73.42, [N.D3, 220, N.C4, 369.99], [N.D5, 739.99, N.A5, N.C5]],
  };

  // Typing sound flavours. Each visit to the website picks one (kept for the
  // rest of the visit), so typing sounds similar but a little different each
  // time: which notes it plays from, the tone, and how bright the key tap is.
  const TYPING_KITS = [
    { notes: [N.G4, N.Bb4, N.C5, N.D5, N.F5, N.G5], type: "sine", tap: 3800, release: 0.28 }, // G minor pentatonic
    { notes: [N.G4, N.A4, N.Bb4, N.C5, N.D5, 659.25, N.F5], type: "triangle", tap: 3200, release: 0.24 }, // G dorian, a touch brighter
    { notes: [N.G4, N.Bb4, N.D5, N.F5, N.A5], type: "sine", tap: 4400, release: 0.34 }, // the notes of a Gm9 chord
    { notes: [N.D5, N.F5, N.G5, N.Bb5, 1046.5], type: "sine", tap: 3000, release: 0.22 }, // higher and glassy
    { notes: [N.Bb3, N.C4, N.D4, N.F4, N.G4], type: "triangle", tap: 2600, release: 0.3 }, // lower and warmer
  ];
  let typingKit = null;
  try {
    const kept = sessionStorage.getItem("nv-typing-kit");
    if (kept !== null) typingKit = TYPING_KITS[Number(kept)];
  } catch (err) {}
  if (!typingKit) {
    const chosen = Math.floor(Math.random() * TYPING_KITS.length);
    typingKit = TYPING_KITS[chosen];
    try {
      sessionStorage.setItem("nv-typing-kit", String(chosen));
    } catch (err) {}
  }

  // Start the sound engine. It's tried as soon as the page loads: browsers
  // that allow this website to play sound straight away (Chrome does for
  // sites people often use; anyone can allow it in their browser's site
  // settings) get sounds from the very first hover. Everywhere else the
  // browser keeps it paused until the first click, tap or key press on the
  // page, which then wakes it up.
  function startSounds() {
    if (sfx) {
      if (sfx.state === "suspended") sfx.resume().catch(() => {});
      return;
    }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    sfx = new Context();
    // Everything goes through one quiet volume control...
    sfx.out = sfx.createGain();
    sfx.out.gain.value = 0.6;
    // ...softened by a gentle filter, so nothing is ever sharp or bright...
    const warmth = sfx.createBiquadFilter();
    warmth.type = "lowpass";
    warmth.frequency.value = 3000;
    sfx.out.connect(warmth).connect(sfx.destination);
    // ...and a large, warm reverb (a room made from fading noise), mixed in generously
    const room = sfx.createConvolver();
    const length = Math.floor(sfx.sampleRate * 3.8);
    const impulse = sfx.createBuffer(2, length, sfx.sampleRate);
    for (let side = 0; side < 2; side++) {
      const data = impulse.getChannelData(side);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
    }
    room.buffer = impulse;
    sfx.wet = sfx.createGain();
    sfx.wet.gain.value = 0.62;
    const roomTone = sfx.createBiquadFilter();
    roomTone.type = "lowpass";
    roomTone.frequency.value = 2200;
    sfx.out.connect(room).connect(roomTone).connect(sfx.wet).connect(sfx.destination);
    // Drums and bass skip the reverb (keeps them tight), through their own volume control
    sfx.dry = sfx.createGain();
    sfx.dry.gain.value = 0.6;
    sfx.dry.connect(sfx.destination);
  }

  // Can a sound play right now?
  function canPlay() {
    if (!soundsOn || !sfx) return false;
    if (sfx.state === "suspended") sfx.resume().catch(() => {});
    return sfx.state === "running";
  }

  // One lush synth note: two slightly detuned oscillators (a warm chorus),
  // a soft filter that can open or close as it plays, gentle fade in and out,
  // placed left or right in the stereo field.
  //   freq: Hz   at: seconds from now   attack/release: seconds
  //   volume: 0–1 (keep it tiny)   type: oscillator shape
  //   bright/brightTo: filter start and end (Hz)   pan: -1 left to 1 right
  function voice({ freq, at = 0, attack = 0.02, release = 0.6, volume = 0.03, type = "triangle", bright = 1800, brightTo = bright, pan = 0, detune = 7, to = null }) {
    // Ambient shaping for every note: it fades in gently, lingers longer,
    // stays warm (never bright) and never buzzes
    attack = Math.max(attack, 0.035);
    release *= 1.6;
    bright = Math.min(bright, 1600);
    brightTo = Math.min(brightTo, 2000);
    if (type === "square") type = "sine";
    const now = sfx.currentTime + at;
    const end = now + attack + release;
    const filter = sfx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(bright, now);
    filter.frequency.exponentialRampToValueAtTime(brightTo, end);
    const level = sfx.createGain();
    level.gain.setValueAtTime(0.0001, now);
    level.gain.exponentialRampToValueAtTime(volume, now + attack);
    level.gain.exponentialRampToValueAtTime(0.0001, end);
    const place = sfx.createStereoPanner ? sfx.createStereoPanner() : null;
    if (place) place.pan.value = pan;
    filter.connect(level).connect(place || to || sfx.out);
    if (place) place.connect(to || sfx.out);
    // Two oscillators, one a touch sharp and one a touch flat
    [-detune, detune].forEach((cents) => {
      const osc = sfx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = cents;
      osc.connect(filter);
      osc.start(now);
      osc.stop(end + 0.05);
    });
  }

  // A soft breath of filtered noise (for air, whooshes and taps)
  function breath({ at = 0, length = 0.3, volume = 0.02, from = 800, to = 3000, q = 1.2 }) {
    // Ambient shaping: softer, a little longer, and never hissy
    from = Math.min(from, 3500);
    to = Math.min(to, 3500);
    q = Math.min(q, 1);
    length *= 1.4;
    volume *= 0.75;
    const now = sfx.currentTime + at;
    const samples = Math.ceil(sfx.sampleRate * length);
    const buffer = sfx.createBuffer(1, samples, sfx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / samples);
    const source = sfx.createBufferSource();
    const band = sfx.createBiquadFilter();
    const level = sfx.createGain();
    source.buffer = buffer;
    band.type = "bandpass";
    band.Q.value = q;
    band.frequency.setValueAtTime(from, now);
    band.frequency.exponentialRampToValueAtTime(to, now + length);
    level.gain.value = volume;
    source.connect(band).connect(level).connect(sfx.out);
    source.start(now);
  }

  // A soft, round kick drum (a sine wave dropping in pitch)
  function kick(at, volume = 0.09) {
    const now = sfx.currentTime + at;
    const osc = sfx.createOscillator();
    const level = sfx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.18);
    level.gain.setValueAtTime(volume, now);
    level.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    osc.connect(level).connect(sfx.dry);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  // Deep bass: a sub-bass sine, plus the same note an octave up so it can be
  // heard on small speakers too
  function bass(freq, at, length, volume = 0.06, to = null) {
    [
      [freq, volume, "sine"],
      [freq * 2, volume * 0.35, "triangle"],
    ].forEach(([f, v, type]) => {
      const now = sfx.currentTime + at;
      const osc = sfx.createOscillator();
      const level = sfx.createGain();
      const soften = sfx.createBiquadFilter();
      osc.type = type;
      osc.frequency.value = f;
      soften.type = "lowpass";
      soften.frequency.value = 420;
      level.gain.setValueAtTime(0.0001, now);
      level.gain.exponentialRampToValueAtTime(v, now + 0.04);
      level.gain.setValueAtTime(v, now + length * 0.7);
      level.gain.exponentialRampToValueAtTime(0.0001, now + length);
      osc.connect(soften).connect(level).connect(to || sfx.dry);
      osc.start(now);
      osc.stop(now + length + 0.05);
    });
  }

  // The chat's open and close music (and the chat button's hover swell) gets
  // a fresh flavour each time the page loads: a different G minor chord
  // colour, tone, strum speed and direction, sparkle note and bloom
  const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
  const TOGGLE = {
    chord: pickOne([
      [N.G2, N.G3, N.Bb3, N.D4, N.F4, N.A4], // Gm9
      [N.G2, N.D3, N.Bb3, N.C4, N.F4, N.A4], // Gm11
      [N.G2, N.G3, N.Bb3, N.D4, N.A4, N.D5], // G minor, add 9
      [N.G2, 155.56, N.G3, N.Bb3, N.D4, N.G4], // Eb major 7 over G
      [N.G2, 130.81, 155.56, N.G3, N.Bb3, N.D4], // C minor 9 over G
      [N.G2, N.D3, N.F4, N.Bb4, N.C5, N.D5], // open, airy G minor 11
    ]),
    type: pickOne(["sawtooth", "triangle", "sine"]),
    strum: pickOne([0.03, 0.045, 0.07, 0.1]),
    downward: Math.random() < 0.35, // strum from the top note down instead of up
    sparkle: pickOne([N.D6, N.A5, N.Bb5, N.G5, 1567.98]),
    bloom: pickOne([1800, 2400, 3000]),
  };

  // What each button sounds like when the mouse comes onto it
  const HOVER_SOUNDS = [
    // Send: a warm little rising pair
    ["#nv-chat-send", () => { voice({ freq: N.D5, release: 0.35, volume: 0.018, bright: 2600 }); voice({ freq: N.G5, at: 0.05, release: 0.4, volume: 0.012, bright: 3000 }); }],
    // Speak: a breathy, airy tone
    ["#nv-mic", () => { breath({ length: 0.35, volume: 0.012, from: 1200, to: 4200, q: 3 }); voice({ freq: N.A5, attack: 0.08, release: 0.35, volume: 0.008, type: "sine" }); }],
    // Voice replies: a low, round bell
    ["#nv-voice-toggle", () => { voice({ freq: N.G3, release: 0.7, volume: 0.022, type: "sine", detune: 4 }); voice({ freq: N.D5, release: 0.5, volume: 0.006, type: "sine" }); }],
    // Sounds: a tiny glassy chime
    ["#nv-sounds", () => voice({ freq: N.Bb5, release: 0.45, volume: 0.009, type: "sine", pan: 0.3 })],
    // Book a session: a lush, shimmering chord
    [".nv-book", () => [N.G4, N.Bb4, N.D5, N.F5, N.A5].forEach((freq, i) => voice({ freq, at: i * 0.035, attack: 0.04, release: 0.9, volume: 0.009, bright: 1400, brightTo: 3400, pan: i / 2 - 1 }))],
    // Close (×): a soft low note that sinks
    ["#nv-chat-close", () => voice({ freq: N.D4, release: 0.4, volume: 0.016, bright: 1600, brightTo: 500 })],
    // Keep chat closed: a muted pluck
    ["#nv-keep-closed", () => voice({ freq: N.C5, attack: 0.005, release: 0.22, volume: 0.016, type: "square", bright: 900, brightTo: 400, detune: 3 })],
    // The chat button: a slow pad swell
    ["#nv-chat-toggle", () => TOGGLE.chord.slice(1, 4).forEach((freq, i) => voice({ freq, at: i * TOGGLE.strum, attack: 0.18, release: 0.6, volume: 0.011, type: TOGGLE.type, bright: 700, brightTo: 1800, pan: (i - 1) * 0.5 }))],
    // The speech bubble: a gentle two-note hello
    ["#nv-chat-teaser button", () => { voice({ freq: N.Bb4, release: 0.3, volume: 0.012, type: "sine" }); voice({ freq: N.F5, at: 0.09, release: 0.45, volume: 0.01, type: "sine" }); }],
    // Links in the chat: a bright glassy ping
    ["#nv-chat-messages a, .nv-privacy a", () => voice({ freq: N.D6, release: 0.35, volume: 0.007, type: "sine", pan: -0.2 })],
  ];

  // Every link and button on the website gets its own soft sound when the
  // mouse moves onto it: a note from G minor, one of five styles and a place
  // left or right, worked out from the link itself. This number is picked
  // fresh each time the page loads, so reloading shuffles which link gets
  // which sound.
  const PAGE_SEED = Math.floor(Math.random() * 1e9);
  const SITE_NOTES = [N.G3, N.Bb3, N.C4, N.D4, N.F4, N.G4, N.A4, N.Bb4, N.C5, N.D5, N.F5, N.G5];
  function siteHover(el) {
    // What makes this link itself: where it goes and what it says
    const name = (el.getAttribute("href") || "") + "|" + (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 60);
    let h = PAGE_SEED;
    for (const c of name) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    const note = SITE_NOTES[h % SITE_NOTES.length];
    const pan = (((h >>> 8) % 11) / 10 - 0.5) * 1.2;
    switch ((h >>> 16) % 5) {
      case 0: // a soft swell
        voice({ freq: note, attack: 0.06, release: 0.5, volume: 0.007, type: "sine", pan });
        break;
      case 1: // two notes together (the note and a fifth above)
        voice({ freq: note, attack: 0.05, release: 0.5, volume: 0.005, type: "sine", pan });
        voice({ freq: note * 1.5, at: 0.05, attack: 0.05, release: 0.6, volume: 0.004, type: "sine", pan: -pan });
        break;
      case 2: // a breath of air with the note inside it
        breath({ length: 0.2, volume: 0.007, from: note * 2, to: note * 3 });
        voice({ freq: note, attack: 0.08, release: 0.45, volume: 0.005, type: "sine", pan });
        break;
      case 3: // a low, warm tone
        voice({ freq: note / 2, attack: 0.07, release: 0.6, volume: 0.011, type: "triangle", bright: 700, pan });
        break;
      default: // a faint, far-away chime
        voice({ freq: note * 2, attack: 0.04, release: 0.8, volume: 0.0035, type: "sine", pan });
    }
  }

  // ----- Scrolling: a soft rush of air, and notes that climb or fall -----
  // The air grows with how fast someone scrolls and gets lighter further down
  // the page; every 90 pixels or so a faint note plays, higher the further
  // down, so scrolling down plays a slow rising melody and scrolling up a falling one.
  const SCROLL_NOTES = [N.G3, N.Bb3, N.C4, N.D4, N.F4, N.G4, N.Bb4, N.C5, N.D5, N.F5, N.G5];
  let scrollAir = null; // the rush of air (made once, then made louder or quieter)
  const scrollSeen = new WeakMap(); // where each scrolling area was last time
  let lastScrollNote = 0;
  let airTimer = null;

  function scrollSound(area) {
    // The page itself, or a scrolling box (like the chat's messages)
    const box = area === document || area === document.documentElement || area === document.body ? document.scrollingElement || document.documentElement : area;
    if (!box || !box.scrollHeight) return;
    const top = box.scrollTop;
    const room = Math.max(1, box.scrollHeight - box.clientHeight);
    const depth = Math.min(1, Math.max(0, top / room)); // 0 at the top, 1 at the bottom
    const before = scrollSeen.get(box) || { top, note: top, time: Date.now() };
    const moved = top - before.top;
    const speed = Math.abs(moved) / Math.max(16, Date.now() - before.time); // pixels per millisecond
    scrollSeen.set(box, { top, note: before.note, time: Date.now() });
    if (!canPlay()) return;
    // The rush of air: a loop of soft noise, made once
    if (!scrollAir) {
      const length = sfx.sampleRate * 2;
      const buffer = sfx.createBuffer(1, length, sfx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      const source = sfx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const band = sfx.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 0.7;
      const level = sfx.createGain();
      level.gain.value = 0;
      source.connect(band).connect(level).connect(sfx.out);
      source.start();
      scrollAir = { band, level };
    }
    const now = sfx.currentTime;
    scrollAir.band.frequency.setTargetAtTime(350 + depth * 1400, now, 0.08);
    scrollAir.level.gain.setTargetAtTime(Math.min(0.016, 0.003 + speed * 0.006), now, 0.06);
    // Fade the air away soon after scrolling stops
    clearTimeout(airTimer);
    airTimer = setTimeout(() => scrollAir.level.gain.setTargetAtTime(0, sfx.currentTime, 0.15), 140);
    // A faint note every 90 pixels or so (at most every 0.07s)
    if (Math.abs(top - before.note) >= 90 && Date.now() - lastScrollNote > 70) {
      lastScrollNote = Date.now();
      scrollSeen.set(box, { top, note: top, time: Date.now() });
      voice({ freq: SCROLL_NOTES[Math.round(depth * (SCROLL_NOTES.length - 1))], attack: 0.04, release: 0.35, volume: 0.0045, type: "sine", pan: moved > 0 ? 0.25 : -0.25, detune: 3 });
    }
  }

  const sound = {
    // Opening: this page load's chord blooming open (the filter sweeps up)
    open() {
      if (!canPlay()) return;
      const notes = TOGGLE.downward ? [...TOGGLE.chord].reverse() : TOGGLE.chord;
      notes.forEach((freq, i) =>
        voice({ freq, at: i * TOGGLE.strum, attack: 0.12, release: 1.3, volume: freq < 100 ? 0.02 : 0.014, type: TOGGLE.type, bright: 500, brightTo: TOGGLE.bloom, pan: (i % 2 ? 1 : -1) * 0.35, detune: 9 })
      );
      voice({ freq: TOGGLE.sparkle, at: 0.3, attack: 0.05, release: 0.9, volume: 0.004, type: "sine" }); // a sparkle on top
      breath({ length: 0.6, volume: 0.008, from: 600, to: 5000 });
    },
    // Closing: the same chord settling back down and darkening (the filter sweeps down)
    close() {
      if (!canPlay()) return;
      const notes = (TOGGLE.downward ? TOGGLE.chord : [...TOGGLE.chord].reverse()).slice(0, 5);
      notes.forEach((freq, i) =>
        voice({ freq, at: i * (TOGGLE.strum + 0.005), attack: 0.04, release: 0.75, volume: 0.012, type: TOGGLE.type, bright: 2200, brightTo: 300, pan: (i % 2 ? -1 : 1) * 0.3, detune: 9 })
      );
      breath({ length: 0.45, volume: 0.007, from: 4000, to: 500 });
    },
    // Hovering over a button: that button's own sound (never more than every 0.12s)
    hover(button) {
      if (!canPlay() || Date.now() - lastHover < 120) return;
      lastHover = Date.now();
      const match = HOVER_SOUNDS.find(([selector]) => button && button.matches(selector));
      if (match) match[1]();
      else siteHover(button); // a link or button on the website: its own sound
    },
    // Typing: letters play soft keys from the scale, space a low velvet thump,
    // deleting a little falling note
    key(key) {
      if (!canPlay() || Date.now() - lastKey < 35) return;
      lastKey = Date.now();
      if (key === "NewLine") {
        // Shift+Enter (a new line): a soft carriage return, a breath sliding
        // down with two low notes settling
        breath({ length: 0.18, volume: 0.01, from: 1400, to: 600 });
        voice({ freq: N.D4, release: 0.3, volume: 0.008, type: "sine", pan: 0.2 });
        voice({ freq: N.G3, at: 0.09, release: 0.45, volume: 0.009, type: "sine", pan: -0.2 });
      } else if (key === "EmptyEnter") {
        // Enter with nothing typed: one soft, quiet note (nothing to send yet)
        voice({ freq: N.Bb3, release: 0.35, volume: 0.008, type: "sine", detune: 2 });
      } else if (key === "Backspace" || key === "Delete") {
        // Deleting: a soft breath drawing back in
        breath({ length: 0.12, volume: 0.012, from: 1800, to: 700 });
      } else if (key === " ") {
        // Space: a low, warm hum, felt more than heard
        voice({ freq: N.G2, release: 0.3, volume: 0.016, type: "sine", detune: 2 });
      } else {
        // Letters: like distant wind chimes, each a little different
        const kit = typingKit;
        const freq = kit.notes[Math.floor(Math.random() * kit.notes.length)];
        voice({ freq, release: kit.release * (0.9 + Math.random() * 0.4), volume: 0.0045, type: "sine", detune: 2 + Math.random() * 4, pan: Math.random() * 1.2 - 0.6 });
        breath({ length: 0.04, volume: 0.006, from: kit.tap * 0.5, to: kit.tap * 0.6 }); // a whisper of air with each key
      }
    },
    // Sending a message: a soft whoosh that rises away
    send() {
      if (!canPlay()) return;
      breath({ length: 0.45, volume: 0.016, from: 500, to: 4500 });
      voice({ freq: N.D5, at: 0.08, attack: 0.03, release: 0.35, volume: 0.012, type: "sine" });
      voice({ freq: N.G5, at: 0.16, attack: 0.03, release: 0.5, volume: 0.01, type: "sine" });
    },
    // A session booked from the booking card: a bright chord rising up, with a shimmer on top
    booked() {
      if (!canPlay()) return;
      [N.G4, N.Bb4, N.D5, N.G5, N.Bb5].forEach((freq, i) =>
        voice({ freq, at: i * 0.07, attack: 0.02, release: 1.4, volume: 0.013, type: "triangle", bright: 900, brightTo: 3200, pan: (i % 2 ? 1 : -1) * 0.3, detune: 6 })
      );
      voice({ freq: N.D6, at: 0.4, attack: 0.03, release: 1.6, volume: 0.005, type: "sine" });
      breath({ at: 0.05, length: 0.7, volume: 0.01, from: 700, to: 6000 });
    },
    // The scrollbar's trail: a tiny glint, higher near the top of the chat,
    // lower near the bottom (very quiet: it sits on top of the scroll whoosh)
    trail(depth) {
      if (!canPlay()) return;
      const notes = [N.D6, N.Bb5, N.A5, N.G5, N.F5, N.D5];
      const freq = notes[Math.min(notes.length - 1, Math.floor(depth * notes.length))];
      voice({ freq, attack: 0.005, release: 0.28, volume: 0.0026, type: "sine", detune: 3, pan: 0.45 });
    },
    // Closing: a breath of air drawn in, then a soft low bell as the button catches it
    tuck() {
      if (!canPlay()) return;
      breath({ length: 0.55, volume: 0.012, from: 3200, to: 380 });
      voice({ freq: N.D5, at: 0.08, attack: 0.02, release: 0.4, volume: 0.006, type: "sine", pan: -0.3 });
      voice({ freq: N.G4, at: 0.56, attack: 0.01, release: 1.2, volume: 0.011, type: "sine", detune: 4, pan: 0.35 });
      voice({ freq: N.G3, at: 0.58, attack: 0.02, release: 1.4, volume: 0.009, type: "triangle", bright: 700, brightTo: 300, pan: 0.35 });
    },
    // A reply arriving: a warm two-note bell
    reply() {
      if (!canPlay()) return;
      voice({ freq: N.Bb4, attack: 0.01, release: 0.8, volume: 0.016, type: "sine", detune: 4, pan: -0.2 });
      voice({ freq: N.F5, at: 0.11, attack: 0.01, release: 1.0, volume: 0.012, type: "sine", detune: 4, pan: 0.2 });
      voice({ freq: N.D6, at: 0.2, attack: 0.02, release: 0.8, volume: 0.003, type: "sine" });
    },
    // Clicking anything in the chat. The mouse button decides the kind of
    // sound, and what was clicked decides its note (so each button, the
    // message box, the header and each message sound a little different):
    //   left: a soft, low bloom   right: a deep, slow swell
    //   middle: two far-away chimes   back/forward: a breath of air one way or the other
    click(which, target) {
      if (!canPlay()) return;
      const thing = target.closest("button, a, textarea, .nv-msg, .nv-header, .nv-tools, .nv-foot") || target;
      // Turn what was clicked into a note from G minor
      const name = (thing.id || thing.className || thing.tagName) + (thing.classList.contains("nv-msg") ? thing.textContent.length % 5 : "");
      let hash = 0;
      for (const c of String(name)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
      const SCALE = [N.G3, N.Bb3, N.C4, N.D4, N.F4, N.G4, N.Bb4, N.D5];
      const note = SCALE[hash % SCALE.length];
      if (which === 0) {
        // Left: a soft, low bloom with a breath of air
        voice({ freq: note, release: 0.4, volume: 0.01, type: "sine", detune: 3 });
        breath({ length: 0.08, volume: 0.008, from: 900, to: 1400 });
      } else if (which === 2) {
        // Right: a deep, slow swell from below
        voice({ freq: note / 2, attack: 0.12, release: 0.8, volume: 0.02, type: "sine", bright: 500, brightTo: 250, detune: 3 });
      } else if (which === 1) {
        // Middle: two faint, far-away chimes
        voice({ freq: note * 2, release: 0.9, volume: 0.005, type: "sine", pan: -0.3 });
        voice({ freq: note * 3, at: 0.12, release: 1.0, volume: 0.004, type: "sine", pan: 0.3 });
      } else {
        breath({ length: 0.3, volume: 0.016, from: which === 3 ? 3200 : 800, to: which === 3 ? 800 : 3200, q: 1.6 });
      }
    },
    // The "Keep chat closed" switch sliding: a breath of air with a note
    // gliding up (switching on) or down (switching off), settling softly
    slide(on) {
      if (!canPlay()) return;
      const now = sfx.currentTime;
      breath({ length: 0.28, volume: 0.022, from: on ? 700 : 3800, to: on ? 3800 : 700, q: 2.2 });
      const osc = sfx.createOscillator();
      const level = sfx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(on ? N.G4 : N.D5, now);
      osc.frequency.exponentialRampToValueAtTime(on ? N.D5 : N.G4, now + 0.22);
      level.gain.setValueAtTime(0.0001, now);
      level.gain.exponentialRampToValueAtTime(0.014, now + 0.05);
      level.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
      osc.connect(level).connect(sfx.out);
      osc.start(now);
      osc.stop(now + 0.45);
      // A soft note as it settles
      voice({ freq: on ? N.D5 : N.G4, at: 0.22, release: 0.5, volume: 0.008, type: "sine", detune: 3 });
    },
    // Booking a session: a short, ambient Novacane piece in G minor: deep sub
    // bass, a soft distant pulse, a warm pad, a slow drifting arpeggio, breaths
    // of air and bells at the end. It's a little different every time: the
    // chords, the tempo (78–88 bpm), the arpeggio's pattern and the closing
    // bells are picked at random. Returns
    // how long to wait before going to the booking page (seconds).
    bookTrack() {
      if (!canPlay()) return 0;
      const any = (list) => list[Math.floor(Math.random() * list.length)];
      const beat = 60 / (78 + Math.random() * 10);
      const step = beat / 2; // a slow, drifting arpeggio
      // The chords it can use: bass note, pad notes, arpeggio notes
      const CHORDS = NOVA_CHORDS;
      // Chord journeys (name, beats), each 5 beats, all coming home to G minor
      const journey = any([
        [["Gm9", 2], ["Ebmaj7", 2], ["F", 1]],
        [["Gm9", 2], ["Cm9", 2], ["D", 1]],
        [["Gm9", 1], ["Bbmaj7", 1], ["Ebmaj7", 2], ["D", 1]],
        [["Gm9", 2], ["Ebmaj7", 1], ["Cm9", 1], ["D", 1]],
        [["Gm9", 2], ["Bbmaj7", 2], ["F", 1]],
      ]);
      // How the arpeggio moves through each chord's notes
      const pattern = any([
        (notes, k) => notes[k % notes.length], // up
        (notes, k) => notes[[0, 1, 2, 3, 2, 1][k % 6] % notes.length], // up and down
        (notes, k) => notes[[0, 2, 1, 3, 2, 4, 1, 3][k % 8] % notes.length], // skipping
        (notes) => any(notes), // wandering
      ]);
      const arpType = any(["triangle", "sine"]);
      let at = 0;
      journey.forEach(([name, beats]) => {
        const [root, pad, arp] = CHORDS[name];
        const length = beats * beat;
        // The bass, and a soft, distant kick at the start of each chord
        bass(root, at, length);
        kick(at, 0.045);
        // The pad, opening up as it plays
        pad.forEach((freq, i) => voice({ freq, at: at + i * 0.02, attack: 0.25, release: length + 0.4, volume: 0.009, type: "sawtooth", bright: 500, brightTo: 2200, pan: (i % 2 ? 1 : -1) * 0.4, detune: 10 }));
        // The arpeggio, bouncing left and right
        for (let k = 0; k * step < length - 0.01; k++) {
          voice({ freq: pattern(arp, k), at: at + k * step, release: 0.6, volume: 0.008, type: arpType, bright: 1600, brightTo: 900, pan: k % 2 ? 0.45 : -0.45, detune: 4 });
        }
        at += length;
      });
      // Texture: slow breaths of air drifting through, like wind past the studio
      for (let b = 0; b < 5; b += 2) breath({ at: b * beat, length: beat * 1.6, volume: 0.008, from: 600, to: 2400 });
      // The landing: back home to G minor, deep bass, a wide chord and bells
      const land = at;
      kick(land, 0.05);
      bass(49, land, 1.6, 0.06);
      any([
        [N.G2, N.D3, N.Bb3, N.D4, N.A4, N.D5, N.G5],
        [N.G2, N.G3, N.Bb3, N.F4, N.A4, N.D5],
        [N.G2, N.D3, N.F4, N.Bb4, N.D5, N.A5],
      ]).forEach((freq, i) => voice({ freq, at: land + i * 0.03, attack: 0.08, release: 1.6, volume: 0.01, type: "sawtooth", bright: 800, brightTo: 3200, pan: (i / 3 - 1) * 0.6, detune: 11 }));
      any([
        [N.D6, 1567.98],
        [N.Bb5, N.D6],
        [N.A5, N.D6],
        [N.G5, N.D6, 1567.98],
      ]).forEach((freq, i) => voice({ freq, at: land + 0.15 + i * 0.13, attack: 0.01, release: 1.2, volume: 0.007, type: "sine" }));
      breath({ at: land, length: 0.9, volume: 0.01, from: 500, to: 6000 });
      // Fade everything out gently just before the booking page opens
      const end = land + 1.1;
      [sfx.out, sfx.dry, sfx.wet].forEach((bus) => {
        const now = sfx.currentTime;
        bus.gain.setValueAtTime(bus.gain.value, now + end - 0.5);
        bus.gain.linearRampToValueAtTime(0.0001, now + end);
      });
      return end;
    },
  };

  function setSounds(on) {
    soundsOn = on;
    if (on && panel.classList.contains("nv-booking")) startMusic();
    if (!on) stopMusic();
    soundsButton.setAttribute("aria-pressed", on ? "true" : "false");
    soundsButton.title = on ? "Turn the chat's sound effects off" : "Turn the chat's sound effects on";
    try {
      localStorage.setItem("nv-sounds", on ? "on" : "off");
    } catch (err) {}
    if (on) {
      startSounds();
      sound.hover(soundsButton);
    }
  }

  // ===== MOVING OUT OF THE WAY =====
  // See MOVE_AWAY_FROM at the top. The window has two spots: "home" (bottom
  // right, by the chat button) and "left" (bottom left). It can also shrink to
  // just its header bar ("small").

  let spot = "home"; // where it is now
  let small = false; // shrunk to its header bar?
  let hovering = false;
  let dragging = false; // pressing on the chat, e.g. dragging its scrollbar
  let checkTimer = null;
  let moveTimer = null;

  // The window's box on screen at a spot, full size or small (worked out from
  // the CSS, so it's right whatever the window is doing right now)
  function boxAt(where, shrunk) {
    const style = getComputedStyle(panel);
    const width = panel.offsetWidth;
    // Its full height: 720px, or its max-height on a short screen (as in novabot.css)
    const height = shrunk ? header.offsetHeight : Math.min(720, parseFloat(style.maxHeight) || 720);
    const gap = parseFloat(style.right);
    const right = where === "left" ? gap + width : document.documentElement.clientWidth - gap;
    const bottom = document.documentElement.clientHeight - parseFloat(style.bottom);
    return { left: right - width, top: bottom - height, right, bottom };
  }

  // How much of the page's `things` a box would cover (in square pixels,
  // counting only things that are really showing there)
  function overlap(things, box) {
    if (!things) return 0;
    let total = 0;
    for (const el of document.querySelectorAll(things)) {
      if (widget.contains(el)) continue;
      // The part of it inside the box, if any
      const r = el.getBoundingClientRect();
      const x1 = Math.max(r.left, box.left);
      const x2 = Math.min(r.right, box.right);
      const y1 = Math.max(r.top, box.top);
      const y2 = Math.min(r.bottom, box.bottom);
      if (x2 - x1 < 4 || y2 - y1 < 4) continue;
      // Check it's really showing there, not hidden behind something else
      const under = document.elementsFromPoint((x1 + x2) / 2, (y1 + y2) / 2).find((found) => !widget.contains(found));
      if (under && el.contains(under)) total += (x2 - x1) * (y2 - y1);
    }
    return total;
  }

  // Is the visitor using the chat right now?
  function inUse() {
    return hovering || dragging || recording || panel.contains(document.activeElement) || panel.classList.contains("nv-booking");
  }

  // How deep the header's jagged edge is: its peaks start 28% up from its
  // bottom (see the clip-path in novabot.css), so messages start below them
  function measurePeaks() {
    if (header.offsetHeight) widget.style.setProperty("--nv-peaks", Math.ceil(header.offsetHeight * 0.32) + "px");
  }
  window.addEventListener("resize", measurePeaks, { passive: true });
  requestAnimationFrame(measurePeaks);

  // Move the window to a spot, full size or small
  function place(where, shrunk) {
    clearTimeout(moveTimer);
    spot = where;
    small = shrunk;
    // How far left the "left" spot is from home
    const shift = where === "left" ? boxAt("left", false).left - boxAt("home", false).left : 0;
    // Set on the whole widget, so the panel and its glow layer both follow
    widget.style.setProperty("--nv-shift", shift + "px");
    widget.style.setProperty("--nv-small-height", header.offsetHeight + "px");
    measurePeaks();
    panel.classList.toggle("nv-small", shrunk);
    if (!shrunk) toggle.classList.remove("nv-unread");
  }

  // Work out the best place for the window right now: its usual spot by the
  // chat button whenever that's clear of things to click, otherwise the other
  // side, otherwise its header bar
  function bestPlace() {
    // Full size somewhere that's clear of things to click
    const clear = ["home", "left"].filter((where) => !overlap(MOVE_AWAY_FROM, boxAt(where, false)));
    if (clear.length) return { where: clear[0], shrunk: false };
    // Nowhere clear: shrink to the header bar, somewhere it's clear if possible
    const where = ["home", "left"].find((w) => !overlap(MOVE_AWAY_FROM, boxAt(w, true))) || "home";
    return { where, shrunk: true };
  }

  function checkPosition() {
    // Phones and tablets: always in its usual place, full size
    if (!isShowing() || matchMedia(PHONE).matches || fingerOnly()) {
      if (spot !== "home" || small) place("home", false);
      return;
    }
    if (inUse() || !MOVE_AWAY_FROM) return;
    const best = bestPlace();
    if (best.where === spot && best.shrunk === small) return;
    // In the way where it is: move straight away
    if (overlap(MOVE_AWAY_FROM, boxAt(spot, small))) return place(best.where, best.shrunk);
    // Not in the way, but somewhere better (e.g. back home, or full size
    // again): only once the page has been still for a moment
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!inUse()) place(best.where, best.shrunk);
    }, COME_BACK_AFTER);
  }

  // Wait for things to settle (scrolling, focus moving) before checking
  function checkSoon(delay) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkPosition, delay);
  }

  // Clicking, tapping or typing on the page: check it isn't in the way
  function pageUsed(e) {
    if (widget.contains(e.target)) return;
    checkSoon(300);
  }

  // Shrunk to its header bar: hovering over it or tapping it opens it up
  function openUp() {
    if (!small) return;
    place(spot, false);
  }

  // ===== THE ON-SCREEN KEYBOARD =====
  // On phones and tablets the keyboard covers the bottom of the screen without
  // the page getting any shorter, so the browser would push the page (and the
  // chat with it) up and down. Instead the chat fits itself to the part of the
  // screen that's still showing (visualViewport): on phones it fills exactly
  // that, on bigger screens it sits just above the keyboard. Then whatever is
  // being typed in stays in view.
  const view = window.visualViewport;
  let fitFrame = 0;
  function fitToScreen() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      const height = view ? view.height : window.innerHeight;
      const top = view ? view.offsetTop : 0;
      // How much of the bottom of the page the keyboard is covering
      const keyboard = Math.max(0, window.innerHeight - height - top);
      widget.style.setProperty("--nv-view-height", Math.round(height) + "px");
      widget.style.setProperty("--nv-view-top", Math.round(top) + "px");
      widget.style.setProperty("--nv-keyboard", Math.round(keyboard) + "px");
      panel.classList.toggle("nv-keyboard", keyboard > 60);
      keepTypingInView();
    });
  }
  // A box in the chat's messages (e.g. on the booking card) being typed in: scroll just enough to see it
  function keepTypingInView() {
    const active = document.activeElement;
    if (!active || !list.contains(active) || !active.matches("input, textarea, select")) return;
    const box = active.getBoundingClientRect();
    const area = list.getBoundingClientRect();
    if (box.bottom > area.bottom - 12) list.scrollTop += box.bottom - area.bottom + 24;
    else if (box.top < area.top + 12) list.scrollTop -= area.top - box.top + 24;
  }
  if (view) {
    view.addEventListener("resize", fitToScreen);
    view.addEventListener("scroll", fitToScreen);
  }
  window.addEventListener("resize", fitToScreen);
  window.addEventListener("orientationchange", fitToScreen);
  panel.addEventListener("focusin", () => setTimeout(fitToScreen, 60));
  fitToScreen();

  // Full screen on a phone: the page behind stays still (no scrolling it by
  // accident, and no jumping when the keyboard comes up)
  function lockPage() {
    const lock = !panel.classList.contains("nv-closed") && !panel.classList.contains("nv-waiting") && matchMedia(PHONE).matches;
    document.documentElement.classList.toggle("nv-page-locked", lock);
  }
  window.addEventListener("resize", lockPage);

  // Size the message box to what's typed, between its CSS min and max heights
  function fitInput() {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + 2 + "px";
  }

  // Add a message to the screen. "who" is "user" or "bot".
  function addMessage(text, who) {
    // A reply arrived while shrunk: make the chat button pulse
    if (who === "bot" && small) toggle.classList.add("nv-unread");
    const div = document.createElement("div");
    div.dataset.text = text;
    div.className = "nv-msg nv-" + who;
    setText(div, text);
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    return div;
  }

  // Show text with any web links made clickable (e.g. booking page, WhatsApp).
  // Built from text nodes, so nothing in a message can inject HTML.
  function setText(div, text) {
    div.dataset.text = text;
    div.textContent = "";
    text.split(/(https?:\/\/[^\s<>"']+)/).forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) div.appendChild(document.createTextNode(part));
        return;
      }
      // Leave trailing punctuation outside the link
      const trail = part.match(/[.,!?;:)]+$/);
      const url = trail ? part.slice(0, -trail[0].length) : part;
      const link = document.createElement("a");
      link.href = url;
      link.textContent = linkLabel(link, url);
      if (link.origin === location.origin) {
        // This website: same tab (the chat carries over)
        link.addEventListener("click", followSiteLink);
      } else {
        link.target = "_blank";
        link.rel = "noopener";
      }
      div.appendChild(link);
      if (trail) div.appendChild(document.createTextNode(trail[0]));
    });
  }

  // What a link says in the chat: long addresses get a friendly name
  function linkLabel(link, url) {
    if (/wa\.me\//.test(url)) return "WhatsApp Odysi";
    // Nova Bot's own booking pages (when the studio uses its own booking system)
    if (isNovaBookingLink(link)) {
      const params = new URL(link.href).searchParams;
      if (link.pathname.startsWith("/pay/")) return params.get("for") === "balance" ? "Pay the balance" : "Pay the deposit";
      if (link.pathname.startsWith("/booking/")) return "View your booking";
      if (params.get("date") && params.get("time")) {
        const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
          .format(new Date(params.get("date") + "T00:00:00Z"))
          .replace(/,/g, "");
        return `Book ${day}, ${params.get("time")}`;
      }
      return params.get("session") ? "Book this session" : "Booking page";
    }
    if (/acuityscheduling\.com$/.test(link.hostname)) {
      // A link with the time already selected: "Book Tue 6 Oct, 14:00"
      const chosen = decodeURIComponent(link.pathname).match(/\/datetime\/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      if (chosen) {
        const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
          .format(new Date(chosen[1] + "T00:00:00Z"))
          .replace(/,/g, "");
        return `Book ${day}, ${chosen[2]}`;
      }
      const params = new URL(link.href).searchParams;
      // A booking NovaBot made: Acuity's pages for paying the deposit or seeing it
      if (params.get("action") === "appt") return /pay/i.test(link.search) ? "Pay the deposit" : "View your booking";
      return params.get("appointmentType") || params.get("appointmentTypeIds[]") ? "Book this session" : "Booking calendar";
    }
    return url.replace(/^https?:\/\//, "");
  }

  // Nova Bot's own booking pages (/book, /booking/…, /pay/…) on its worker
  function isNovaBookingLink(link) {
    let worker;
    try {
      worker = new URL(WORKER_URL);
    } catch (err) {
      return false;
    }
    return link.hostname === worker.hostname && /^\/(book|booking|pay)(\/|$)/.test(link.pathname);
  }

  // Join lines that were broken in the middle of a sentence.
  // Keeps real paragraph breaks and "-" / "1." list items on their own lines.
  function tidy(text) {
    return text
      .replace(/\r/g, "")
      .replace(/[ \t]*\n(?!\n|\s*([-•*]|\d+[.)])\s)[ \t]*/g, (match, _, offset, all) =>
        all[offset - 1] === "\n" ? match : " "
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // "Book it for me" or "I'll book it myself": two buttons under NovaBot's
  // reply when someone has picked a free time and NovaBot asks how they'd
  // like to book it. "For me" asks NovaBot to book it in the chat; "myself"
  // opens the booking page with that time already selected.
  function showChoice(link) {
    clearChoice();
    let url;
    try {
      url = new URL(link);
    } catch (err) {
      return;
    }
    const acuity = url.protocol === "https:" && /(^|\.)acuityscheduling\.com$/.test(url.hostname);
    if (!acuity && !isNovaBookingLink(url)) return;

    const box = document.createElement("div");
    box.className = "nv-choice";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "How would you like to book?");

    const forMe = document.createElement("button");
    forMe.type = "button";
    forMe.className = "nv-choice-me";
    forMe.textContent = "Book it for me";
    forMe.addEventListener("click", () => {
      clearChoice();
      sendMessage("Book it for me, please");
    });

    const myself = document.createElement("a");
    myself.className = "nv-choice-self";
    myself.href = url.href;
    myself.target = "_blank";
    myself.rel = "noopener";
    myself.textContent = "I'll book it myself";
    myself.addEventListener("click", () => {
      clearChoice();
      const said = "I'll book it myself";
      const answer = "The booking page is open in a new tab with your time already selected. Fill in your details and pay the deposit to lock it in.";
      addMessage(said, "user");
      addMessage(answer, "bot");
      // So NovaBot knows what they chose if they carry on chatting
      history.push({ role: "user", content: said }, { role: "assistant", content: answer });
      saveChat();
    });

    box.append(forMe, myself);
    list.appendChild(box);
    list.scrollTop = list.scrollHeight;
  }

  function clearChoice() {
    list.querySelectorAll(".nv-choice").forEach((box) => box.remove());
  }

  // ===== The booking card =====
  // When someone wants to book, NovaBot opens this card instead of asking for
  // each detail in turn: the session, a strip of days, that day's free start
  // times, and name, email and phone, filled in with whatever they've already
  // said. "Book it" sends it all at once (the Worker checks the time again),
  // then the card bursts open with a button to pay the deposit on the booking
  // page, which is what books it (Nova Bot's own system books it straight away).

  const CARD_WEEKS = 8; // how many weeks ahead the day picker goes
  const daysBetween = (from, to) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);

  // ===== The booking card's music =====
  // While the booking card is open, a soft Novacane loop plays underneath: the
  // studio's G minor chords as slow, warm pads, a gentle bell arpeggio that
  // drifts left and right, deep bass and the odd breath of air. No drums. It
  // fades in, fades out when the card closes, and follows the Sounds switch.
  const MUSIC_BPM = 68;
  const MUSIC_JOURNEYS = [
    ["Gm9", "Ebmaj7", "Bbmaj7", "F"],
    ["Gm9", "Cm9", "Ebmaj7", "D"],
    ["Gm9", "Bbmaj7", "Cm9", "D"],
  ];
  const music = { timer: null, wet: null, dry: null, next: 0, step: 0, journey: MUSIC_JOURNEYS[0] };

  function startMusic() {
    if (music.timer || !soundsOn) return;
    startSounds();
    if (!sfx || !canPlay()) return;
    // Its own volume controls (through the reverb, and dry for the bass), so it can fade on its own
    music.wet = sfx.createGain();
    music.dry = sfx.createGain();
    music.wet.connect(sfx.out);
    music.dry.connect(sfx.dry);
    [music.wet, music.dry].forEach((bus) => {
      bus.gain.setValueAtTime(0.0001, sfx.currentTime);
      bus.gain.exponentialRampToValueAtTime(1, sfx.currentTime + 3);
    });
    music.next = sfx.currentTime + 0.15;
    music.step = 0;
    scheduleMusic();
    music.timer = setInterval(scheduleMusic, 400);
  }

  function stopMusic() {
    if (!music.timer) return;
    clearInterval(music.timer);
    music.timer = null;
    const buses = [music.wet, music.dry];
    buses.forEach((bus) => {
      bus.gain.cancelScheduledValues(sfx.currentTime);
      bus.gain.setValueAtTime(Math.max(bus.gain.value, 0.0001), sfx.currentTime);
      bus.gain.exponentialRampToValueAtTime(0.0001, sfx.currentTime + 1.8);
    });
    setTimeout(() => buses.forEach((bus) => bus.disconnect()), 2600);
  }

  // Keep a couple of seconds of music scheduled ahead, one chord at a time
  function scheduleMusic() {
    if (!canPlay()) return;
    while (music.next < sfx.currentTime + 2) {
      const index = music.step % 4;
      if (index === 0) music.journey = MUSIC_JOURNEYS[Math.floor(Math.random() * MUSIC_JOURNEYS.length)];
      const [root, pad, arp] = NOVA_CHORDS[music.journey[index]];
      const beat = 60 / MUSIC_BPM;
      const length = beat * 4;
      const at = music.next - sfx.currentTime;
      // Warm pads, swelling slowly
      pad.forEach((freq, i) =>
        voice({ freq, at: at + i * 0.04, attack: 1.1, release: length * 0.75, volume: 0.0055, type: "sawtooth", bright: 380, brightTo: 1100, pan: (i % 2 ? 1 : -1) * 0.35, detune: 12, to: music.wet })
      );
      // Deep, soft bass
      bass(root, at, length * 0.95, 0.028, music.dry);
      // A gentle bell arpeggio, not on every step, drifting left and right
      for (let k = 0; k < 8; k++) {
        if (Math.random() < 0.45) continue;
        voice({ freq: arp[(k + index) % arp.length], at: at + k * (beat / 2), attack: 0.01, release: 0.9, volume: 0.0042, type: "sine", bright: 1400, brightTo: 900, pan: k % 2 ? 0.5 : -0.5, detune: 3, to: music.wet });
      }
      // Now and then a high shimmer, and a breath of air
      if (index === 0) voice({ freq: N.D6, at: at + beat * 2, attack: 0.3, release: 2.2, volume: 0.0018, type: "sine", to: music.wet });
      if (index === 2) breath({ at: at + beat, length: beat * 2, volume: 0.004, from: 500, to: 1800 });
      music.next += length;
      music.step++;
    }
  }

  // No music in a tab that's out of sight; back on when it's looked at again
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMusic();
    else if (isShowing() && panel.classList.contains("nv-booking")) startMusic();
  });

  // Booking mode: while the booking card is open the chat grows (as big as the
  // screen allows) and tucks away everything else, so the whole card shows at
  // once. It eases back when the card is closed or the booking is done.
  // Scroll a card to just below the header's peaks (the message area starts
  // underneath them, so messages can scroll under the see-through edge)
  function scrollToCard(card) {
    if (!card.isConnected) return;
    const below = parseFloat(getComputedStyle(list).paddingTop) || 0;
    list.scrollTop += card.getBoundingClientRect().top - list.getBoundingClientRect().top - below + 4;
  }
  function enterBooking(card) {
    panel.classList.add("nv-booking");
    startMusic();
    place("home", false);
    // The card is the only thing showing now, so the top of the message area is the top of the card
    const showCard = () => (list.scrollTop = 0);
    requestAnimationFrame(showCard);
    setTimeout(showCard, 500); // again once it has finished growing
  }
  function exitBooking(card) {
    panel.classList.remove("nv-booking");
    stopMusic();
    if (card) setTimeout(() => scrollToCard(card), 500);
  }
  const ymdLabel = (ymd, opts) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(new Date(ymd + "T00:00:00Z"));
  const addDay = (ymd, n) => {
    const d = new Date(ymd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // "14:00" -> "2pm", "10:30" -> "10:30am"
  const niceTime = (t) => {
    const [h, m] = t.split(":").map(Number);
    return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function postJson(path, body) {
    const res = await fetch(WORKER_URL + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }

  function showForm(form) {
    if (!form || !Array.isArray(form.sessions) || form.sessions.length === 0) return;
    list.querySelectorAll(".nv-card").forEach((old) => old.remove());
    const today = /^\d{4}-\d{2}-\d{2}$/.test(form.today || "") ? form.today : new Date().toISOString().slice(0, 10);
    const state = {
      session: form.sessions.some((s) => s.id === form.session_type_id) ? form.session_type_id : null,
      date: form.date && form.date >= today ? form.date : "",
      time: form.time || "",
      busy: false,
    };
    let timesAsked = 0; // so a slow answer for an old day can't overwrite a newer one

    const card = el("form", "nv-card");
    card.setAttribute("aria-label", "Book a session");
    card.noValidate = true;
    const glow = el("div", "nv-card-glow");
    glow.setAttribute("aria-hidden", "true");
    const close = el("button", "nv-feedback-close nv-card-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close booking");
    close.addEventListener("click", () => {
      card.remove();
      exitBooking();
    });
    const title = el("div", "nv-card-title", "Book your session");
    const body = el("div", "nv-card-body");

    // Session
    const sessionLabel = el("label", "nv-card-label", "Session");
    const sessionBox = el("select", "nv-card-select");
    sessionBox.append(el("option", "", "Choose a session…"));
    sessionBox.firstChild.value = "";
    form.sessions.forEach((s) => {
      const option = el("option", "", s.price ? `${s.name} · ${s.price}` : s.name);
      option.value = String(s.id);
      if (s.id === state.session) option.selected = true;
      sessionBox.append(option);
    });
    sessionLabel.append(sessionBox);

    // Days: one week at a time, all seven showing, with arrows for other weeks
    const dayLabel = el("div", "nv-card-label nv-card-label-row");
    const weekNav = el("span", "nv-week-nav");
    const prevWeek = el("button", "nv-week-arrow", "‹");
    const nextWeek = el("button", "nv-week-arrow", "›");
    const weekName = el("span", "nv-week-name");
    prevWeek.type = nextWeek.type = "button";
    prevWeek.setAttribute("aria-label", "Earlier days");
    nextWeek.setAttribute("aria-label", "Later days");
    weekNav.append(prevWeek, weekName, nextWeek);
    dayLabel.append(el("span", "", "Day"), weekNav);
    const dayStrip = el("div", "nv-card-days");
    dayStrip.setAttribute("role", "listbox");
    dayStrip.setAttribute("aria-label", "Day");
    const lastWeek = Math.max(CARD_WEEKS - 1, state.date ? Math.floor(daysBetween(today, state.date) / 7) : 0);
    let week = state.date ? Math.floor(daysBetween(today, state.date) / 7) : 0;

    function drawWeek(direction) {
      dayStrip.textContent = "";
      const first = addDay(today, week * 7);
      for (let i = 0; i < 7; i++) {
        const d = addDay(first, i);
        const chip = el("button", "nv-day");
        chip.type = "button";
        chip.dataset.date = d;
        chip.setAttribute("role", "option");
        chip.setAttribute("aria-label", ymdLabel(d, { weekday: "long", day: "numeric", month: "long" }));
        const top = d === today ? "Today" : d === addDay(today, 1) ? "Tmrw" : ymdLabel(d, { weekday: "short" });
        chip.append(el("span", "nv-day-name", top), el("span", "nv-day-num", ymdLabel(d, { day: "numeric" })));
        chip.addEventListener("click", () => {
          state.date = d;
          state.time = "";
          refresh();
          loadTimes();
        });
        dayStrip.append(chip);
      }
      weekName.textContent = `${ymdLabel(first, { day: "numeric", month: "short" })} – ${ymdLabel(addDay(first, 6), { day: "numeric", month: "short" })}`;
      prevWeek.disabled = week === 0;
      nextWeek.disabled = week >= lastWeek;
      dayStrip.classList.remove("nv-days-from-left", "nv-days-from-right");
      if (direction) {
        void dayStrip.offsetWidth; // restart the slide
        dayStrip.classList.add(direction < 0 ? "nv-days-from-left" : "nv-days-from-right");
      }
      refresh();
    }
    prevWeek.addEventListener("click", () => {
      week = Math.max(0, week - 1);
      drawWeek(-1);
    });
    nextWeek.addEventListener("click", () => {
      week = Math.min(lastWeek, week + 1);
      drawWeek(1);
    });

    // Times
    const timeLabel = el("div", "nv-card-label", "Start time");
    const timeGrid = el("div", "nv-card-times");
    timeGrid.setAttribute("role", "listbox");
    timeGrid.setAttribute("aria-label", "Start time");

    // Details
    const field = (name, placeholder, type, value, autocomplete) => {
      const box = el("input", "nv-card-input");
      box.name = name;
      box.type = type;
      box.placeholder = placeholder;
      box.value = value || "";
      box.autocomplete = autocomplete;
      box.setAttribute("aria-label", placeholder);
      box.addEventListener("input", () => box.classList.remove("nv-card-wrong"));
      return box;
    };
    const first = field("first_name", "First name", "text", form.first_name, "given-name");
    const last = field("last_name", "Last name", "text", form.last_name, "family-name");
    const email = field("email", "Email", "email", form.email, "email");
    const phone = field("phone", "Phone", "tel", form.phone, "tel");
    const nameRow = el("div", "nv-card-row");
    nameRow.append(first, last);
    const contactRow = el("div", "nv-card-row");
    contactRow.append(email, phone);
    const detailsLabel = el("div", "nv-card-label", "Your details");

    const summary = el("div", "nv-card-summary");
    summary.setAttribute("aria-live", "polite");
    const problem = el("div", "nv-card-problem");
    problem.setAttribute("role", "alert");
    // With Acuity (form.choose) they pick how: "Book it for me" (NovaBot checks
    // the time and fills it all in, then they pay the deposit, which books it) or
    // "I'll book it myself" (Acuity's booking page for the session). Nothing is
    // booked until the deposit's paid.
    const bookButton = el("button", "nv-card-book");
    bookButton.type = "submit";
    bookButton.dataset.label = form.choose ? "Book it for me" : "Book it";
    bookButton.append(el("span", "nv-card-book-text", bookButton.dataset.label));
    const selfButton = el("button", "nv-card-book nv-card-self");
    selfButton.type = "button";
    selfButton.dataset.label = "I'll book it myself";
    selfButton.append(el("span", "nv-card-book-text", selfButton.dataset.label));
    selfButton.addEventListener("click", () => {
      const s = form.sessions.find((x) => x.id === state.session);
      const page = (s && s.page) || BOOKING_LINK;
      window.open(page, "_blank", "noopener");
    });
    const buttons = form.choose ? [bookButton, selfButton] : [bookButton];

    // Grouped into sections, so the spare space can go evenly between them
    const section = (...parts) => {
      const box = el("div", "nv-card-section");
      box.append(...parts);
      return box;
    };
    body.append(
      section(sessionLabel),
      section(dayLabel, dayStrip),
      section(timeLabel, timeGrid),
      section(detailsLabel, nameRow, contactRow),
      summary,
      problem,
      ...buttons
    );
    card.append(glow, close, title, body);
    list.appendChild(card);
    enterBooking(card);

    function sessionName() {
      const s = form.sessions.find((x) => x.id === state.session);
      return s ? s.name : "";
    }

    // Show what's chosen: highlighted day and time, and the one-line summary
    function refresh() {
      dayStrip.querySelectorAll(".nv-day").forEach((chip) => {
        const on = chip.dataset.date === state.date;
        chip.classList.toggle("nv-day-on", on);
        chip.setAttribute("aria-selected", String(on));
      });
      timeGrid.querySelectorAll(".nv-time").forEach((chip) => {
        const on = chip.dataset.time === state.time;
        chip.classList.toggle("nv-time-on", on);
        chip.setAttribute("aria-selected", String(on));
      });
      summary.textContent =
        state.session && state.date && state.time
          ? `${sessionName()} · ${ymdLabel(state.date, { weekday: "long", day: "numeric", month: "long" })} at ${niceTime(state.time)}`
          : "";
      summary.classList.toggle("nv-card-summary-on", Boolean(summary.textContent));
    }

    // That day's free start times for the chosen session
    async function loadTimes() {
      timeGrid.textContent = "";
      if (!state.session || !state.date) {
        timeGrid.append(el("div", "nv-card-note", state.session ? "Pick a day to see the free times." : "Pick a session first."));
        return;
      }
      const asked = ++timesAsked;
      for (let i = 0; i < 6; i++) timeGrid.append(el("span", "nv-time nv-time-loading"));
      let data;
      try {
        data = await postJson("/booking-form/times", { session_type_id: state.session, date: state.date });
      } catch (err) {
        data = { times: [], message: "Couldn't check the free times just now. Please try again." };
      }
      if (asked !== timesAsked) return;
      timeGrid.textContent = "";
      const times = Array.isArray(data.times) ? data.times : [];
      if (times.length === 0) {
        timeGrid.append(el("div", "nv-card-note", data.message || "No free times this day. Try another day."));
        state.time = "";
      }
      if (!times.includes(state.time)) state.time = "";
      times.forEach((t, i) => {
        const chip = el("button", "nv-time", niceTime(t));
        chip.type = "button";
        chip.dataset.time = t;
        chip.setAttribute("role", "option");
        chip.style.animationDelay = `${Math.min(i, 20) * 22}ms`;
        chip.addEventListener("click", () => {
          state.time = t;
          problem.textContent = "";
          refresh();
        });
        timeGrid.append(chip);
      });
      refresh();
    }

    sessionBox.addEventListener("change", () => {
      state.session = Number(sessionBox.value) || null;
      state.time = "";
      refresh();
      loadTimes();
    });

    function wrong(box, message) {
      box.classList.add("nv-card-wrong");
      problem.textContent = message;
      box.focus();
    }

    card.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (state.busy) return;
      problem.textContent = "";
      if (!state.session) return wrong(sessionBox, "Choose a session.");
      if (!state.date || !state.time) {
        problem.textContent = "Pick a day and a start time.";
        return;
      }
      if (!first.value.trim() || !last.value.trim()) return wrong(!first.value.trim() ? first : last, "Please add your first and last name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) return wrong(email, "That email address doesn't look right.");
      if (!phone.value.trim()) return wrong(phone, "Please add your phone number.");

      state.busy = true;
      card.classList.add("nv-card-sending");
      buttons.forEach((b) => (b.disabled = true));
      bookButton.querySelector(".nv-card-book-text").textContent = form.choose ? "Checking…" : "Booking…";
      sound.send();
      const details = {
        chatId,
        session_type_id: state.session,
        date: state.date,
        time: state.time,
        first_name: first.value.trim(),
        last_name: last.value.trim(),
        email: email.value.trim(),
        phone: phone.value.trim(),
      };
      let data;
      try {
        data = await postJson("/booking-form/book", details);
      } catch (err) {
        data = { ok: false, message: "Sorry, I couldn't connect. Please try again." };
      }
      state.busy = false;
      card.classList.remove("nv-card-sending");
      buttons.forEach((b) => {
        b.disabled = false;
        b.querySelector(".nv-card-book-text").textContent = b.dataset.label;
      });

      if (!data.ok) {
        problem.textContent = data.message || "Sorry, that couldn't be booked.";
        if (data.field === "email") email.classList.add("nv-card-wrong");
        if (data.field === "phone") phone.classList.add("nv-card-wrong");
        if (data.field === "name") first.classList.add("nv-card-wrong");
        if (data.field === "time") loadTimes();
        if (data.url) {
          const link = el("a", "nv-card-link", "Finish booking on the booking page");
          link.href = data.url;
          link.target = "_blank";
          link.rel = "noopener";
          problem.append(document.createElement("br"), link);
        }
        return;
      }
      celebrate(data, details);
    });

    // Done: the card folds into a glowing tick with sparks flying off it.
    // payFirst (Acuity): the time's free and filled in, and it's booked once
    // they pay the deposit on the booking page. Otherwise (Nova Bot's own
    // system) it's in, with its link to pay the deposit.
    function celebrate(data, details) {
      const when = `${ymdLabel(details.date, { weekday: "long", day: "numeric", month: "long" })} at ${niceTime(details.time)}`;
      const payFirst = Boolean(data.payFirst && data.pay && data.pay.url);
      card.classList.add("nv-card-done");
      sound.booked();
      const done = el("div", "nv-card-done-box");
      const tick = el("div", "nv-card-tick");
      tick.setAttribute("aria-hidden", "true");
      tick.innerHTML = '<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="23"/><path d="M15 27l7 7 15-16"/></svg>';
      done.append(tick, el("div", "nv-card-done-title", payFirst ? "All set: just pay the deposit" : "You're booked in!"), el("div", "nv-card-done-when", `${sessionName()}\n${when}`), el("div", "nv-card-done-note", data.message));
      if (data.pay && data.pay.url) {
        const pay = el("a", "nv-card-pay", data.pay.label || "Pay the deposit now");
        pay.href = data.pay.url;
        pay.target = "_blank";
        pay.rel = "noopener";
        done.appendChild(pay);
      }
      body.replaceWith(done);
      close.remove();
      title.textContent = payFirst ? "Pay the deposit to book" : "Booking received";
      setTimeout(() => exitBooking(card), 2600);
      if (!calm) {
        const box = tick.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        [0, 120, 260].forEach((delay) => setTimeout(() => sparkle(x, y, 14), delay));
      }
      // So NovaBot knows how it went if they carry on chatting
      const said = payFirst
        ? `I chose a time with the booking card: ${sessionName()}, ${when}, for ${details.first_name} ${details.last_name} (${details.email}, ${details.phone}).`
        : `I booked with the booking card: ${sessionName()}, ${when}, for ${details.first_name} ${details.last_name} (${details.email}, ${details.phone}).`;
      const answer = payFirst
        ? `Not booked yet: ${sessionName()} on ${when} is free, and it's booked once the deposit is paid here: ${data.pay.url}`
        : `Booked: ${sessionName()} on ${when}. ${data.message}${data.pay && data.pay.url ? ` Pay the deposit here: ${data.pay.url}` : ""}`;
      history.push({ role: "user", content: said }, { role: "assistant", content: answer });
      saveChat();
      requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
    }

    drawWeek();
    loadTimes();
  }

  // ===== Feedback about NovaBot =====
  // The Feedback button opens a little card: thumbs up or down, and what they
  // think, typed or spoken (the mic records until it's tapped again, then the
  // Worker turns it into text, which lands in the box to check before sending).
  // It's saved with the last few messages so the team can see what it was about.

  const FEEDBACK_SECONDS = 40; // the longest spoken feedback (the Worker takes about 45s of audio)

  function showFeedback() {
    const open = list.querySelector(".nv-feedback");
    if (open) {
      open.querySelector("textarea").focus();
      return;
    }
    let rating = "";
    let spoken = false;
    let recorder = null;

    const card = el("form", "nv-card nv-feedback");
    card.setAttribute("aria-label", "Feedback about NovaBot");
    card.noValidate = true;
    const glow = el("div", "nv-card-glow");
    glow.setAttribute("aria-hidden", "true");
    const close = el("button", "nv-feedback-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close feedback");
    // While it's open the message box tucks away (like for the booking card), so the whole card fits
    const endFeedback = () => panel.classList.remove("nv-feedbacking");
    close.addEventListener("click", () => {
      card.remove();
      endFeedback();
    });
    const title = el("div", "nv-card-title", "Help NovaBot get better");
    const body = el("div", "nv-card-body");

    const rates = el("div", "nv-feedback-rates");
    rates.setAttribute("role", "group");
    rates.setAttribute("aria-label", "How was NovaBot?");
    const rateButton = (value, face, label) => {
      const b = el("button", "nv-rate", face);
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        rating = rating === value ? "" : value;
        rates.querySelectorAll(".nv-rate").forEach((x) => x.setAttribute("aria-pressed", String(x === b && rating === value)));
        if (rating && !calm) {
          const box = b.getBoundingClientRect();
          sparkle(box.left + box.width / 2, box.top + box.height / 2, 8);
        }
      });
      return b;
    };
    rates.append(rateButton("good", "👍", "NovaBot was helpful"), rateButton("bad", "👎", "NovaBot wasn't helpful"));

    const box = el("textarea", "nv-card-input nv-feedback-text");
    box.rows = 3;
    box.maxLength = 3000;
    box.placeholder = "What could NovaBot do better? Type it, or tap Speak.";
    box.setAttribute("aria-label", "Your feedback");

    const row = el("div", "nv-feedback-row");
    const mic = el("button", "nv-feedback-mic");
    mic.type = "button";
    mic.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg><span>Speak</span>';
    const sendButton = el("button", "nv-card-book nv-feedback-send");
    sendButton.type = "submit";
    sendButton.append(el("span", "nv-card-book-text", "Send feedback"));
    row.append(mic, sendButton);
    const note = el("div", "nv-card-problem");
    note.setAttribute("role", "status");
    if (!navigator.mediaDevices || !window.MediaRecorder) mic.hidden = true;

    const micLabel = (text) => (mic.querySelector("span").textContent = text);

    // Speak: record until tapped again (or FEEDBACK_SECONDS), then turn it into text
    mic.addEventListener("click", async () => {
      if (recorder) return recorder.stop();
      stopSpeaking();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (err) {
        note.textContent = "Microphone access is blocked, but you can type it instead.";
        return;
      }
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.addEventListener("dataavailable", (e) => chunks.push(e.data));
      const limit = setTimeout(() => recorder && recorder.stop(), FEEDBACK_SECONDS * 1000);
      recorder.addEventListener("stop", async () => {
        clearTimeout(limit);
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType;
        recorder = null;
        mic.classList.remove("nv-recording");
        micLabel("Turning it into text…");
        mic.disabled = true;
        try {
          const wav = await toWav(new Blob(chunks, { type }));
          const res = await fetch(WORKER_URL + "/listen", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
          const data = await res.json();
          if (data.text) {
            box.value = (box.value.trim() ? box.value.trim() + " " : "") + data.text.trim();
            spoken = true;
            note.textContent = "";
          } else {
            note.textContent = "Sorry, I couldn't make that out. Try again, or type it.";
          }
        } catch (err) {
          note.textContent = "Sorry, I couldn't make that out. Try again, or type it.";
        }
        mic.disabled = false;
        micLabel("Speak");
      });
      recorder.start();
      mic.classList.add("nv-recording");
      micLabel("Listening… tap to stop");
    });

    card.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (recorder) recorder.stop();
      const message = box.value.trim();
      if (!message && !rating) {
        note.textContent = "Pick 👍 or 👎, or tell us what you think.";
        box.focus();
        return;
      }
      sendButton.disabled = true;
      sendButton.querySelector(".nv-card-book-text").textContent = "Sending…";
      let data;
      try {
        data = await postJson("/feedback", { chatId, page: location.pathname, rating, message, spoken, recent: history.slice(-12) });
      } catch (err) {
        data = { ok: false, message: "Sorry, that didn't send. Please try again." };
      }
      sendButton.disabled = false;
      sendButton.querySelector(".nv-card-book-text").textContent = "Send feedback";
      if (!data.ok) {
        note.textContent = data.message || "Sorry, that didn't send. Please try again.";
        return;
      }
      // Thank you: the card settles into a glowing star
      sound.reply();
      const done = el("div", "nv-card-done-box");
      const star = el("div", "nv-feedback-star", "✦");
      star.setAttribute("aria-hidden", "true");
      done.append(star, el("div", "nv-card-done-title", "Thank you!"), el("div", "nv-card-done-note", data.message));
      body.replaceWith(done);
      close.remove();
      card.classList.add("nv-card-done");
      endFeedback();
      if (!calm) {
        const b = star.getBoundingClientRect();
        [0, 150].forEach((delay) => setTimeout(() => sparkle(b.left + b.width / 2, b.top + b.height / 2, 12), delay));
      }
      setTimeout(() => card.classList.add("nv-feedback-fade"), 4500);
      setTimeout(() => card.remove(), 5200);
    });

    body.append(rates, box, row, note);
    card.append(glow, close, title, body);
    list.appendChild(card);
    panel.classList.add("nv-feedbacking");
    requestAnimationFrame(() => {
      // Its top in view (title and thumbs), not its bottom
      scrollToCard(card);
      if (!fingerOnly()) box.focus({ preventScroll: true });
    });
  }

  widget.querySelector("#nv-feedback").addEventListener("click", showFeedback);

  // ===== The scrollbar's trail =====
  // As the scrollbar handle moves, faint glowing copies of it are left where
  // it just was, fading away in under a second, with a soft glint now and then.
  // (Drawn over the scrollbar, since a real scrollbar can't draw a trail.)
  const touchScreen = matchMedia("(hover: none), (pointer: coarse)").matches; // no trail (and no work) on touch screens
  const trail = el("div", "nv-scroll-trail");
  trail.setAttribute("aria-hidden", "true");
  panel.appendChild(trail);
  let lastThumb = null;
  let lastGhost = 0;
  let lastGlint = 0;
  // Where the scrollbar handle is: its top and height inside the message area
  function thumbBox() {
    const height = list.clientHeight;
    const total = list.scrollHeight;
    if (total <= height + 1) return null;
    const thumb = Math.max(48, (height * height) / total); // 48px at least, as in novabot.css
    return { top: (list.scrollTop / (total - height)) * (height - thumb), height: thumb };
  }
  list.addEventListener(
    "scroll",
    () => {
      const box = thumbBox();
      if (calm || touchScreen || !box) return (lastThumb = box);
      const now = performance.now();
      if (lastThumb && Math.abs(box.top - lastThumb.top) > 2 && now - lastGhost > 28) {
        const area = panel.getBoundingClientRect();
        const messages = list.getBoundingClientRect();
        const ghost = el("span", "nv-scroll-ghost");
        ghost.style.top = messages.top - area.top + lastThumb.top + "px";
        ghost.style.height = lastThumb.height + "px";
        ghost.style.right = area.right - messages.right + 3 + "px";
        trail.appendChild(ghost);
        setTimeout(() => ghost.remove(), 900);
        lastGhost = now;
        if (now - lastGlint > 160) {
          lastGlint = now;
          sound.trail(list.scrollTop / Math.max(1, list.scrollHeight - list.clientHeight));
        }
      }
      lastThumb = box;
    },
    { passive: true }
  );

  // Send what the visitor typed (or said), or `said` (from a button)
  async function sendMessage(said) {
    const typed = typeof said !== "string";
    const text = (typed ? input.value : said).trim();
    if (!text || send.disabled) return;

    stopSpeaking();
    clearChoice();
    if (typed) {
      input.value = "";
      fitInput();
    }
    addMessage(text, "user");
    sound.send();
    acted();
    history.push({ role: "user", content: text });

    // Show "typing…" and stop double-sending
    send.disabled = true;
    const typing = addMessage("NovaBot is typing…", "bot");
    typing.classList.add("nv-typing");

    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, chatId, page: location.pathname }),
      });
      const data = await res.json();

      if (data.reply) {
        const replyText = tidy(data.reply);
        setText(typing, replyText);
        sound.reply();
        history.push({ role: "assistant", content: data.reply });
        speak(replyText);
        if (data.choice && data.choice.link) showChoice(data.choice.link);
        if (data.form) showForm(data.form);
      } else {
        setText(typing, data.message || "Sorry, something went wrong. Please try again.");
        history.pop();
      }
    } catch (err) {
      setText(typing, "Sorry, I couldn't connect. Please try again.");
      history.pop();
    }

    // Swap "typing…" into a normal reply
    typing.classList.remove("nv-typing");
    saveChat();
    send.disabled = false;
    input.focus();
    list.scrollTop = list.scrollHeight;
  }

  // ===== NovaBot's voice (text to speech) =====
  // 1. If the visitor's device has a good British female voice (most phones,
  //    Chrome, Edge, Macs), NovaBot uses that: British, free, no download.
  // 2. Otherwise the Worker makes the speech (MeloTTS, female, American accent).
  // 3. If that's unavailable too, any English voice on the device reads it.

  const synth = window.speechSynthesis;
  const player = new Audio();
  let voiceOn = false;
  let britishVoice = null; // a good British female voice on this device, if any
  let browserVoice = null; // the best English voice on this device (last resort)
  let speakId = 0; // lets a newer reply cancel an older one still loading
  let unlocked = false;

  // Phones only allow audio after a tap, so "unlock" the player on the first tap
  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    player.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
    player.play().catch(() => {});
  }

  // Known good British female voices, best first:
  // Edge (Natural), Chrome, Apple, Windows, then Android's UK voice
  const BRITISH_FEMALE = [
    /(libby|sonia|maisie|hollie|bella|abbi|olivia).*natural/i,
    /google uk english female/i,
    /serena|kate|stephanie|martha|flo\b|shelley/i,
    /hazel|susan/i,
    /english united kingdom/i,
  ];
  // Robotic system voices (e.g. Linux) aren't good enough to be first choice
  const ROBOTIC = /espeak|pico|festival|mbrola/i;

  function chooseBrowserVoice() {
    const voices = synth.getVoices().filter((v) => !ROBOTIC.test(v.name));
    britishVoice = null;
    for (const pattern of BRITISH_FEMALE) {
      britishVoice = voices.find((v) => /^en[-_]GB/i.test(v.lang) && pattern.test(v.name));
      if (britishVoice) break;
    }
    const score = (v) =>
      (/^en[-_]GB/i.test(v.lang) ? 10 : /^en/i.test(v.lang) ? 4 : 0) +
      (/natural|neural|premium|enhanced/i.test(v.name) ? 5 : 0) +
      (/female|serena|libby|sonia|kate|stephanie|martha|hazel|susan|samantha|zira|aria|jenny/i.test(v.name) ? 6 : 0);
    browserVoice = britishVoice || synth.getVoices().sort((a, b) => score(b) - score(a))[0] || null;
  }

  // Make the reply sound right when read aloud
  function forSpeech(text) {
    return text
      .replace(/https?:\/\/\S+/g, "the link in the chat")
      .replace(/\b0\d{4}\s?\d{3}\s?\d{3}\b/g, (n) => n.replace(/\s/g, "").split("").join(" "))
      .replace(/\p{Extended_Pictographic}|\uFE0F/gu, "")
      .replace(/\bGBP\s?(?=\d)/g, "£")
      .replace(/(\d)\s?GBP\b/g, "$1 pounds")
      .replace(/£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g, sayPounds)
      .replace(/\b(pounds?)\s+sterling\b/gi, "$1")
      .replace(/\bsterling\b/gi, "pounds")
      .replace(/£/g, "pounds")
      .replace(/(?<![\d-])(\d{1,3})\s*[–—-]\s*(\d{1,3})(?![\d-])/g, "$1 to $2")
      .replace(/\s*\/\s*(hour|hr|song|track|session|day|person)\b/gi, " per $1")
      .replace(/(\w)\/(\w)/g, "$1 or $2")
      .replace(/^\s*[-•*]\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // "£50" -> "50 pounds", "£1" -> "1 pound", "£12.50" -> "12 pounds 50",
  // "£0.50" -> "50p" (so the voice doesn't say "sterling")
  function sayPounds(match, whole, pence) {
    const pounds = Number(whole.replace(/,/g, ""));
    const p = pence && pence !== "00" ? Number(pence) : 0;
    if (pounds === 0 && p) return p + "p";
    const said = pounds.toLocaleString("en-GB") + (pounds === 1 ? " pound" : " pounds");
    return p ? said + " " + p : said;
  }

  async function speak(text) {
    if (!voiceOn) return;
    stopSpeaking();
    const id = speakId;
    const words = forSpeech(text);
    if (!words) return;

    // Device has a good British voice: use it
    if (britishVoice) {
      speakWithBrowser(words);
      return;
    }

    try {
      const res = await fetch(WORKER_URL + "/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: words }),
      });
      if (!res.ok) throw new Error("Voice unavailable");
      const audio = await res.blob();
      if (id !== speakId) return; // stopped or replaced while loading
      URL.revokeObjectURL(player.src);
      player.src = URL.createObjectURL(audio);
      await player.play();
    } catch (err) {
      if (id === speakId) speakWithBrowser(words);
    }
  }

  // The device's own voice, one sentence at a time
  // (some browsers cut off long speech)
  function speakWithBrowser(words) {
    if (!synth || !browserVoice) return;
    (words.match(/[^.!?]+[.!?]*/g) || []).forEach((sentence) => {
      const line = new SpeechSynthesisUtterance(sentence.trim());
      line.lang = "en-GB";
      line.voice = browserVoice;
      line.rate = 1;
      synth.speak(line);
    });
  }

  function stopSpeaking() {
    speakId++;
    player.pause();
    if (synth) synth.cancel();
  }

  function setVoice(on) {
    voiceOn = on;
    voiceToggle.setAttribute("aria-pressed", on ? "true" : "false");
    voiceToggle.title = on ? "Voice replies on: tap to mute" : "Turn on voice replies";
    if (!on) stopSpeaking();
    try {
      localStorage.setItem("nv-voice", on ? "on" : "off");
    } catch (err) {}
  }

  if (voiceToggle) {
    if (synth) {
      chooseBrowserVoice();
      synth.addEventListener("voiceschanged", chooseBrowserVoice);
    }
    let saved = null;
    try {
      saved = localStorage.getItem("nv-voice");
    } catch (err) {}
    // Off unless the visitor has switched it on before
    setVoice(saved === "on");
    voiceToggle.hidden = false;

    // Glow gently until they've tried it once, so they notice it's there
    let tried = null;
    try {
      tried = localStorage.getItem("nv-voice-tried");
    } catch (err) {}
    if (!tried) voiceToggle.classList.add("nv-nudge");

    voiceToggle.addEventListener("click", () => {
      unlockAudio();
      setVoice(!voiceOn);
      voiceToggle.classList.remove("nv-nudge");
      try {
        localStorage.setItem("nv-voice-tried", "yes");
      } catch (err) {}
    });
  }

  // ===== Talking to NovaBot (speech to text) =====
  // Records the visitor, stops by itself when they go quiet, then the Worker
  // works out what they said (Whisper). Works in every modern browser.

  const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  let recording = null; // the current recording, while listening

  function setMicState(state) {
    // state: "idle", "listening" or "thinking"
    mic.classList.toggle("nv-listening", state === "listening");
    mic.setAttribute("aria-pressed", state === "listening" ? "true" : "false");
    mic.disabled = state === "thinking";
    input.placeholder =
      state === "listening" ? "Listening… tap the mic when you're done"
      : state === "thinking" ? "Working out what you said…"
      : "Type or tap the mic…";
  }

  async function startListening() {
    unlockAudio();
    stopSpeaking();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      addMessage("I can't hear you, as microphone access is blocked. You can still type your message.", "bot");
      return;
    }

    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.addEventListener("dataavailable", (e) => chunks.push(e.data));

    // Watch the volume so it can stop by itself when they go quiet
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const started = Date.now();
    let spoke = false;
    let lastSound = Date.now();

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const loud = Math.sqrt(sum / samples.length) > 0.02;
      const now = Date.now();
      if (loud) {
        spoke = true;
        lastSound = now;
      }
      if ((spoke && now - lastSound > 1500) || // paused after talking
          (!spoke && now - started > 7000) ||   // never said anything
          now - started > 20000) {              // 20 second limit
        stopListening();
      }
    }, 100);

    recorder.addEventListener("stop", async () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      context.close();
      recording = null;
      if (!spoke || chunks.length === 0) {
        setMicState("idle");
        return;
      }
      setMicState("thinking");
      try {
        const wav = await toWav(new Blob(chunks, { type: recorder.mimeType }));
        const res = await fetch(WORKER_URL + "/listen", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: wav,
        });
        const data = await res.json();
        setMicState("idle");
        if (data.text) {
          input.value = data.text;
          sendMessage();
        } else if (!res.ok) {
          addMessage("Sorry, I couldn't make that out. Try again, or type your message.", "bot");
        }
      } catch (err) {
        setMicState("idle");
        addMessage("Sorry, I couldn't make that out. Try again, or type your message.", "bot");
      }
    });

    recording = recorder;
    recorder.start();
    setMicState("listening");
  }

  function stopListening() {
    if (recording && recording.state === "recording") recording.stop();
  }

  // Turn any recording into a small 16kHz mono WAV, which the Worker can
  // always read (Safari records in a format it can't)
  async function toWav(blob) {
    const decoder = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
    decoder.close();

    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const pcm = (await offline.startRendering()).getChannelData(0);

    const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // bytes per second
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);       // 16-bit
    text(36, "data");
    view.setUint32(40, pcm.length * 2, true);
    pcm.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
    return new Blob([view], { type: "audio/wav" });
  }

  if (canRecord && mic) {
    mic.hidden = false;
    mic.addEventListener("click", () => (recording ? stopListening() : startListening()));
  }

  // Carry on the chat from the last page, or greet the visitor (the greeting
  // is shown on screen only, not sent to the Worker)
  if (Array.isArray(saved.shown) && saved.shown.length) {
    saved.shown.forEach((message) => addMessage(message.text, message.who === "user" ? "user" : "bot"));
  } else {
    addMessage(pick(GREETINGS), "bot");
    saveChat();
  }

  // The chat window starts open, except on phones (where it would fill the
  // screen) or when the <script> tag says data-closed
  // (or if the visitor closed it on an earlier page)
  // (and always if the visitor switched on "Keep chat closed")
  keepClosedSwitch.setAttribute("aria-checked", keepClosed ? "true" : "false");
  if (keepClosed || (saved.closed && !matchMedia(PHONE).matches)) {
    panel.classList.add("nv-closed");
  } else if (matchMedia(PHONE).matches || fingerOnly() || (script && script.hasAttribute("data-closed"))) {
    panel.classList.add("nv-closed");
    setTimeout(showTeaser, TEASER_DELAY);
  } else {
    // Hold it back until the page has finished loading (5 seconds at most),
    // then show it with its animation. If it would land on something on the
    // page, it moves out of the way straight away.
    panel.classList.add("nv-waiting");
    if (document.readyState === "complete") requestAnimationFrame(showPanel);
    else {
      window.addEventListener("load", showPanel);
      setTimeout(showPanel, 5000);
    }
  }

  function showPanel() {
    if (!panel.classList.contains("nv-waiting")) return;
    panel.classList.remove("nv-waiting");
    toggle.setAttribute("aria-expanded", "true");
    checkPosition();
  }

  // ===== THE ENQUIRY FORM =====
  // Links ending in #enquiry (NovaBot gives these out) scroll down to the
  // form on the page, e.g. novacane.co.uk/bookings-contact#enquiry

  function scrollToEnquiryForm() {
    if (location.hash !== "#enquiry") return;
    const form = document.querySelector(".sqs-block-form, .form-block, form");
    if (!form) return;
    const block = form.closest(".sqs-block") || form;
    // Leave room for a header that stays at the top of the screen
    const siteHeader = document.querySelector("#header, header");
    const headerStyle = siteHeader ? getComputedStyle(siteHeader).position : "";
    const headerHeight = headerStyle === "fixed" || headerStyle === "sticky" ? siteHeader.offsetHeight : 0;
    const top = block.getBoundingClientRect().top + window.scrollY - headerHeight - 24;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  }

  function goToEnquiryForm() {
    scrollToEnquiryForm();
    // Images above the form can still be loading and push it down: check again
    setTimeout(scrollToEnquiryForm, 900);
  }

  // A link in the chat to a page on this website
  function followSiteLink(e) {
    const link = e.currentTarget;
    if (link.pathname !== location.pathname || link.hash !== "#enquiry") return;
    // Already on that page: just scroll down to the form
    e.preventDefault();
    if (location.hash !== "#enquiry") window.history.replaceState(null, "", "#enquiry");
    if (matchMedia(PHONE).matches && isShowing()) openClose(); // full-screen chat would cover it
    goToEnquiryForm();
  }

  if (document.readyState === "complete") goToEnquiryForm();
  else window.addEventListener("load", goToEnquiryForm);
  window.addEventListener("hashchange", goToEnquiryForm);

  // Connect the buttons. If the chat is shrunk to its header bar, the chat
  // button opens it up instead of closing it.
  toggle.addEventListener("click", () => {
    // Pressed before the page finished loading: show it now
    if (panel.classList.contains("nv-waiting")) {
      panel.classList.remove("nv-waiting");
      toggle.setAttribute("aria-expanded", "true");
      return input.focus();
    }
    if (!small) return openClose();
    openUp();
    input.focus();
  });
  if (close) close.addEventListener("click", openClose);
  teaser.querySelector(".nv-teaser-open").addEventListener("click", openClose);
  teaser.querySelector(".nv-teaser-close").addEventListener("click", hideTeaser);
  keepClosedSwitch.addEventListener("click", () => setKeepClosed(!keepClosed));

  // ===== NOVACANE CURSOR AND SOUNDS ALL OVER THE WEBSITE =====
  // The Novacane cursors (novabot.css) work on the whole page, inside and
  // outside the chat, whether the chat is open, closed or kept closed. Links
  // and buttons anywhere on the website sparkle as the mouse passes over them
  // and make the same soft sounds as the chat's buttons. (Mouse only: phones
  // and tablets are left alone.)
  const CLICKABLE = 'a, button, [role="button"], label, select, summary, input[type="submit"], input[type="button"]';
  document.documentElement.classList.add("nv-site-cursor");

  // Just after a click on something, the cursor becomes the Novacane sigil for a moment
  let actedTimer = null;
  function acted() {
    document.documentElement.classList.add("nv-acted");
    clearTimeout(actedTimer);
    actedTimer = setTimeout(() => document.documentElement.classList.remove("nv-acted"), 1200);
  }
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest && e.target.closest(CLICKABLE)) acted();
    },
    true
  );

  // "Book a session", the chat's main button: opens the booking card in the
  // chat. If booking in the chat isn't available, it plays the Novacane track
  // with the booking moment showing, then goes to the booking page (straight
  // there if sounds are off, or if they open it in a new tab).
  const book = widget.querySelector(".nv-book");
  const moment = widget.querySelector(".nv-booking-moment");
  let leaving = null;
  function goBook() {
    clearTimeout(leaving);
    location.href = book.href;
  }
  let opening = false;
  book.addEventListener("click", async (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    // First choice: the booking card, right here in the chat
    e.preventDefault();
    if (opening) return;
    opening = true;
    book.classList.add("nv-book-busy");
    let form = null;
    try {
      form = (await postJson("/booking-form/open", {})).form;
    } catch (err) {
      form = null;
    }
    opening = false;
    book.classList.remove("nv-book-busy");
    if (form) {
      sound.reply();
      clearChoice();
      showForm(form);
      return;
    }
    // Booking in the chat isn't available: the booking page, as before
    if (!soundsOn) return goBook();
    startSounds();
    if (!sfx) return goBook(); // this browser can't make sound: go straight there
    e.preventDefault();
    // The browser may have the sound paused until now: this click lets it
    // start (waiting a third of a second at most, so the button always works)
    if (sfx.state !== "running") await Promise.race([sfx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    const wait = sound.bookTrack();
    if (!wait) return goBook(); // still no sound: go straight there
    stopSpeaking();
    moment.hidden = false;
    leaving = setTimeout(goBook, wait * 1000);
  });
  moment.querySelector(".nv-moment-go").addEventListener("click", goBook);
  // Coming back with the browser's Back button: hide the moment and bring the volume back
  window.addEventListener("pageshow", () => {
    clearTimeout(leaving);
    moment.hidden = true;
    if (!sfx) return;
    [
      [sfx.out, 0.6],
      [sfx.dry, 0.6],
      [sfx.wet, 0.62],
    ].forEach(([bus, level]) => {
      bus.gain.cancelScheduledValues(sfx.currentTime);
      bus.gain.setValueAtTime(level, sfx.currentTime);
    });
  });

  // Sound effects: start the engine on the first click or key press anywhere,
  // tick when hovering over the chat's buttons, tap while typing
  soundsButton.setAttribute("aria-pressed", soundsOn ? "true" : "false");
  soundsButton.addEventListener("click", () => setSounds(!soundsOn));
  ["pointerdown", "keydown", "touchend"].forEach((type) => document.addEventListener(type, startSounds, { capture: true, passive: true }));
  // Try straight away, in case this browser allows sound without a click
  if (soundsOn) startSounds();
  // Any click on the page, in the chat or on the website (left, right,
  // middle, back or forward button) makes its sound, with a little burst of sparkles
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "mouse" || !e.target.closest) return;
      sound.click(e.button, e.target);
      sparkle(e.clientX, e.clientY, 6);
    },
    true
  );
  // Scrolling the page or the chat: its soft sound, but only when it's the
  // visitor scrolling with a mouse or keys (the wheel, dragging the scroll
  // bar, or arrow / page keys), never when the page or chat scrolls itself
  // (like the chat moving down to a new reply), and never on phones
  let lastScrollInput = 0;
  let holding = false; // a mouse button is held down (e.g. dragging the scroll bar)
  let usingTouch = false;
  document.addEventListener("wheel", () => (lastScrollInput = Date.now()), { capture: true, passive: true });
  document.addEventListener(
    "keydown",
    (e) => {
      if (/^(Arrow|Page|Home|End| $)/.test(e.key) || e.key === " ") lastScrollInput = Date.now();
    },
    true
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      usingTouch = e.pointerType !== "mouse";
      holding = e.pointerType === "mouse";
    },
    true
  );
  document.addEventListener("pointerup", () => (holding = false), true);
  document.addEventListener(
    "scroll",
    (e) => {
      if (usingTouch || (!holding && Date.now() - lastScrollInput > 600)) return;
      scrollSound(e.target);
    },
    { capture: true, passive: true }
  );

  // Moving onto a link or button, in the chat or on the website: its soft sound
  document.addEventListener(
    "pointerover",
    (e) => {
      if (e.pointerType !== "mouse" || !e.target.closest) return;
      const button = e.target.closest(CLICKABLE);
      // Only when the mouse first comes onto it (not moving within it)
      if (button && !button.contains(e.relatedTarget)) sound.hover(button);
    },
    true
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" || e.key === "Delete" || e.key.length === 1) sound.key(e.key);
    // Shift+Enter starts a new line; Enter with nothing typed has nothing to send
    // (Enter with a message plays the sending sound instead)
    else if (e.key === "Enter" && !e.isComposing) {
      if (e.shiftKey) sound.key("NewLine");
      else if (!input.value.trim()) sound.key("EmptyEnter");
    }
  });

  // Sparkles: a soft trail behind the mouse over the chat and over the
  // website's links and buttons, and a little burst wherever someone clicks
  // (mouse only, and not for people who ask for less motion)
  function sparkle(x, y, count = 1) {
    if (calm) return;
    for (let i = 0; i < count; i++) {
      // Mostly tiny glowing dots, now and then a little star
      const spark = document.createElement("span");
      spark.className = Math.random() < 0.25 ? "nv-spark nv-star" : "nv-spark";
      if (spark.classList.contains("nv-star")) spark.textContent = "✦";
      const spread = count > 1 ? 18 : 10;
      spark.style.left = x + (Math.random() * spread - spread / 2) + "px";
      spark.style.top = y + (Math.random() * spread - spread / 2) + "px";
      // Each one drifts away in a slightly different direction
      spark.style.setProperty("--nv-dx", Math.random() * (count > 1 ? 40 : 16) - (count > 1 ? 20 : 8) + "px");
      spark.style.setProperty("--nv-dy", (count > 1 ? -10 : 6) + Math.random() * (count > 1 ? 30 : 12) + "px");
      widget.appendChild(spark);
      setTimeout(() => spark.remove(), 800);
    }
  }
  let lastSpark = 0;
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse" || Date.now() - lastSpark < 55 || !e.target.closest) return;
      // Only over the chat, or over a link or button on the website
      if (!widget.contains(e.target) && !e.target.closest(CLICKABLE)) return;
      lastSpark = Date.now();
      sparkle(e.clientX, e.clientY);
    },
    { capture: true, passive: true }
  );
  send.addEventListener("click", () => {
    unlockAudio();
    sendMessage();
  });
  input.addEventListener("keydown", function (e) {
    // Enter sends; Shift+Enter starts a new line
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      unlockAudio();
      sendMessage();
    }
  });
  // The message box grows with what's typed (up to about 5 lines)
  input.addEventListener("input", fitInput);

  // Move out of the way of the page when needed
  panel.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    hovering = true;
    openUp();
  });
  // Tapping the header bar while shrunk opens it up (not when tapping the ×)
  header.addEventListener("click", (e) => {
    if (small && !e.target.closest("#nv-chat-close")) {
      openUp();
      input.focus();
    }
  });
  panel.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    hovering = false;
    checkSoon(600);
  });
  panel.addEventListener("focusout", () => checkSoon(300));
  // Dragging the scrollbar can take the pointer outside the chat: stay put until let go
  panel.addEventListener("pointerdown", () => (dragging = true));
  document.addEventListener(
    "pointerup",
    () => {
      if (!dragging) return;
      dragging = false;
      checkSoon(600);
    },
    true
  );
  document.addEventListener("pointerdown", pageUsed, true);
  document.addEventListener("focusin", pageUsed, true);
  document.addEventListener("keydown", pageUsed, true);
  document.addEventListener("scroll", () => checkSoon(150), { capture: true, passive: true });
  window.addEventListener("resize", () => checkSoon(150));
  window.addEventListener("load", () => checkSoon(300));

  // The chat button's waveform: page media (these events don't bubble, so
  // listen on the way down) and NovaBot's own voice
  ["playing", "pause", "ended", "emptied", "volumechange"].forEach((type) => {
    document.addEventListener(
      type,
      (e) => {
        if (e.target instanceof HTMLMediaElement) mediaChanged(e.target);
      },
      true
    );
    player.addEventListener(type, () => mediaChanged(player));
  });
  checkSoon(800);
})();
