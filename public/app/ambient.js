/* Nova Ambient: a gentle, never-ending ambient soundtrack for Nova Hub.
   Everything is made live with the Web Audio API: no audio files, no libraries,
   no network. Slow warm pads, a soft bass, little star-like bells, a faint
   ocean of air, all washed in a big procedural reverb.

   Usage (from a tap/click handler):
     NovaAmbient.toggle().then(playing => ...)
     NovaAmbient.setVolume(0.4)
     NovaAmbient.onchange = playing => updateButton(playing)
*/
(function () {
  'use strict';

  // ---- Musical material ---------------------------------------------------
  // Chords in D major with a dreamy lydian tint. MIDI numbers (60 = middle C).
  // Upper notes are voiced close together so moving between chords is smooth.
  const CH = {
    D:  { bass: 38, notes: [50, 57, 61, 64, 66] }, // Dmaj9
    Bm: { bass: 35, notes: [50, 54, 57, 61, 64] }, // Bm11
    G:  { bass: 31, notes: [50, 54, 59, 61, 66] }, // Gmaj7#11
    A:  { bass: 33, notes: [52, 57, 59, 61, 64] }, // Aadd9
    Em: { bass: 40, notes: [52, 55, 59, 62, 66] }  // Em9
  };
  const PROGRESSION = [CH.D, CH.Bm, CH.G, CH.A, CH.D, CH.Em, CH.G, CH.A];

  // High D major pentatonic notes for the twinkling "stars".
  const STARS = [74, 76, 78, 81, 83, 86, 88, 90];

  const MAX_GAIN = 0.8;      // master level at volume 1 (kept well below clipping)
  const FADE_IN = 4;         // seconds
  const FADE_OUT = 2;        // seconds

  // ---- State ----------------------------------------------------------------
  let ctx = null;            // the AudioContext, created on the first start()
  let master, comp, padBus, starBus, reverbIn, bassBus;
  let playing = false;
  let volume = 0.5;
  let timer = null;          // lookahead scheduler interval
  let stopTimer = null;      // pending "suspend after fade-out"
  let step = 0;              // position in the chord progression
  let nextChordAt = 0;
  let nextStarAt = 0;

  // ---- Small helpers --------------------------------------------------------
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function gain(value) { const g = ctx.createGain(); g.gain.value = value; return g; }
  function osc(type, freq) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; return o; }
  function filter(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    return f;
  }

  // Stereo placement; very old Safari has no StereoPanner, so just pass through.
  function panner(v) {
    if (!ctx.createStereoPanner) return gain(1);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, v));
    return p;
  }

  // Glide a parameter from wherever it is now to a new value (no clicks).
  function glide(param, value, seconds) {
    const now = ctx.currentTime;
    const current = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
    param.linearRampToValueAtTime(value, now + seconds);
  }

  // A soft swell: fade up, hold, then fade away. Returns when it's silent.
  function envelope(g, t, peak, attack, hold, release) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + hold);
    g.gain.setTargetAtTime(0, t + hold, release / 5);
    return t + hold + release + 0.5;
  }

  // When a sound finishes, unplug all its nodes so nothing piles up over hours.
  function disposeWhenDone(source, nodes) {
    source.onended = () => {
      for (const n of nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } }
    };
  }

  // ---- Reverb: a procedural "big room" impulse response -----------------------
  // Stereo noise that decays over ~5 s and gets darker as it fades.
  function makeImpulse(seconds) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let smooth = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const k = 0.9 - 0.75 * (i / len);               // brightness falls over time
        smooth += k * ((Math.random() * 2 - 1) - smooth);
        const fadeIn = Math.min(1, i / (rate * 0.01));  // no sharp start
        d[i] = smooth * Math.exp(-6.9 * t / seconds) * (1 - i / len) * fadeIn;
      }
    }
    return buf;
  }

  // ---- Build the mixing desk (once) -------------------------------------------
  function buildGraph() {
    // Master: gentle compressor, then the volume knob.
    master = gain(0);
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 24; comp.ratio.value = 3;
    comp.attack.value = 0.05; comp.release.value = 0.6;
    comp.connect(master);
    master.connect(ctx.destination);

    // Reverb send/return.
    reverbIn = gain(1);
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(5.5);
    const verbOut = gain(0.9);
    reverbIn.connect(verb);
    verb.connect(verbOut);
    verbOut.connect(comp);

    // Pads: a little dry, a lot of reverb.
    padBus = gain(1);
    padBus.connect(gain(0.45)).connect(comp);
    padBus.connect(gain(0.9)).connect(reverbIn);

    // Bass goes mostly dry so it stays round and clear.
    bassBus = gain(1);
    bassBus.connect(comp);
    bassBus.connect(gain(0.2)).connect(reverbIn);

    // Stars: dry + a soft, darkened echo + reverb.
    starBus = gain(1);
    starBus.connect(gain(0.6)).connect(comp);
    starBus.connect(gain(0.6)).connect(reverbIn);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.52;                 // roughly a dotted eighth
    const echoTone = filter('lowpass', 2200, 0.3);
    const echoOut = gain(0.5);
    starBus.connect(delay).connect(echoTone).connect(gain(0.35)).connect(delay); // feedback loop
    echoTone.connect(echoOut);
    echoOut.connect(comp);
    echoOut.connect(reverbIn);

    buildAir();
  }

  // ---- Air / ocean bed: filtered noise that slowly breathes ------------------
  function buildAir() {
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const hp = filter('highpass', 120, 0.3);
    const lp = filter('lowpass', 550, 0.3);
    const level = gain(0.012);

    // Slow swell of the volume (like distant waves) ...
    const swell = osc('sine', 0.045);
    const swellAmt = gain(0.009);
    swell.connect(swellAmt).connect(level.gain);
    // ... and an even slower drift of the tone.
    const drift = osc('sine', 0.018);
    const driftAmt = gain(220);
    drift.connect(driftAmt).connect(lp.frequency);

    src.connect(hp).connect(lp).connect(level);
    level.connect(comp);
    level.connect(reverbIn);
    src.start(); swell.start(); drift.start();
  }

  // ---- Pads: one voice = two detuned saws (filtered) + a pure sine ----------
  function padVoice(midi, t, hold, pan) {
    const f = mtof(midi);
    const out = gain(0);
    const place = panner(pan);
    out.connect(place).connect(padBus);

    // Warm low-pass with its own slow wobble.
    const lp = filter('lowpass', rand(750, 1300), 0.4);
    lp.connect(out);
    const lfo = osc('sine', rand(0.03, 0.08));
    const lfoAmt = gain(rand(200, 400));
    lfo.connect(lfoAmt).connect(lp.frequency);

    const sawA = osc('sawtooth', f), sawB = osc('sawtooth', f);
    sawA.detune.value = rand(-9, -5);
    sawB.detune.value = rand(5, 9);
    sawA.connect(lp); sawB.connect(lp);

    const sine = osc('sine', f);
    const sineAmt = gain(0.7);
    sine.connect(sineAmt).connect(out);

    const end = envelope(out, t, 0.02, rand(4, 6), hold, rand(5, 6.5));
    for (const s of [lfo, sawA, sawB, sine]) { s.start(t); s.stop(end); }
    disposeWhenDone(sawA, [out, place, lp, lfo, lfoAmt, sawA, sawB, sine, sineAmt]);
  }

  // ---- Bass: a quiet sine, plus its octave so phone speakers can hear it ----
  function bassNote(midi, t, hold) {
    const f = mtof(midi);
    const out = gain(0);
    out.connect(bassBus);
    const sub = osc('sine', f);
    const upper = osc('sine', f * 2);
    const upperAmt = gain(0.35);
    sub.connect(out);
    upper.connect(upperAmt).connect(out);
    const end = envelope(out, t, 0.07, 4, hold, 5);
    sub.start(t); upper.start(t);
    sub.stop(end); upper.stop(end);
    disposeWhenDone(sub, [out, sub, upper, upperAmt]);
  }

  // ---- A whole chord: pads spread across the stereo field + bass -------------
  function playChord(chord, t, length) {
    let notes = chord.notes.slice();
    // Now and then leave out an inner note so the texture breathes.
    if (Math.random() < 0.3) notes.splice(1 + Math.floor(Math.random() * (notes.length - 2)), 1);
    notes.forEach((m, i) => {
      const pan = (i / (notes.length - 1) - 0.5) * 1.1 + rand(-0.1, 0.1);
      padVoice(m, t + rand(0, 0.6), length, pan);
    });
    bassNote(chord.bass, t, length);
  }

  // ---- Stars: a soft bell (sine + quieter triangle an octave up) -------------
  function playStar(t) {
    const f = mtof(pick(STARS));
    const place = panner(rand(-0.7, 0.7));
    place.connect(starBus);

    const body = gain(0);
    body.gain.setValueAtTime(0, t);
    body.gain.linearRampToValueAtTime(0.03, t + 0.01);
    body.gain.setTargetAtTime(0, t + 0.012, rand(0.6, 1.2));

    const shine = gain(0);
    shine.gain.setValueAtTime(0, t);
    shine.gain.linearRampToValueAtTime(0.008, t + 0.006);
    shine.gain.setTargetAtTime(0, t + 0.008, 0.25);

    const a = osc('sine', f);
    const b = osc('triangle', f * 2);
    a.connect(body).connect(place);
    b.connect(shine).connect(place);
    const end = t + 7;
    a.start(t); b.start(t);
    a.stop(end); b.stop(end);
    disposeWhenDone(a, [a, b, body, shine, place]);
  }

  // ---- Lookahead scheduler -----------------------------------------------------
  // Every 200 ms, book any chords/stars due in the next moment using the audio
  // clock (which keeps perfect time even if the timer itself is late). When the
  // page is hidden, timers get throttled, so we plan further ahead.
  function tick() {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const ahead = document.hidden ? 30 : 1.5;

    // If we fell far behind (e.g. after a pause), start fresh instead of piling up.
    if (nextChordAt < now - 0.5) nextChordAt = now + 0.1;
    if (nextStarAt < now - 0.5) nextStarAt = now + rand(1, 3);

    while (nextChordAt < now + ahead) {
      const length = rand(16, 24);
      playChord(PROGRESSION[step % PROGRESSION.length], nextChordAt, length);
      step++;
      nextChordAt += length;
    }
    while (nextStarAt < now + ahead) {
      playStar(nextStarAt);
      // Sometimes a second star answers the first.
      if (Math.random() < 0.3) playStar(nextStarAt + rand(0.2, 0.45));
      nextStarAt += rand(2, 7);
    }
  }

  // ---- Context setup (lazy, inside a user gesture for iOS) --------------------
  function ensureContext() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    // Let iOS treat this as media playback (plays with the ringer switch off).
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    buildGraph();
    nextChordAt = ctx.currentTime + 0.1;
    nextStarAt = ctx.currentTime + 3;
    return true;
  }

  // Older iOS only unlocks audio after something actually plays in a tap.
  function unlock() {
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(ctx.destination);
    s.onended = () => s.disconnect();
    s.start(0);
  }

  // If the OS interrupted us (phone call, other app), try again on the next tap.
  function wake() {
    if (playing && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }
  document.addEventListener('pointerdown', wake, true);
  document.addEventListener('touchend', wake, { capture: true, passive: true });
  document.addEventListener('keydown', wake, true);
  // Keep playing in the background; just nudge it awake when we come back.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

  function setPlaying(value) {
    if (playing === value) return;
    playing = value;
    if (typeof api.onchange === 'function') {
      try { api.onchange(playing); } catch (e) { /* listener's problem, not ours */ }
    }
  }

  // ---- Public API ---------------------------------------------------------------
  async function start() {
    if (!ensureContext()) return;
    clearTimeout(stopTimer);
    stopTimer = null;
    unlock();
    // resume() can hang while iOS has us "interrupted", so don't wait forever.
    await Promise.race([
      ctx.resume().catch(() => {}),
      new Promise((r) => setTimeout(r, 1500))
    ]);
    if (!timer) timer = setInterval(tick, 200);
    tick();
    glide(master.gain, volume * MAX_GAIN, FADE_IN);
    setPlaying(true);
  }

  function stop() {
    if (!ctx || !playing) return;
    setPlaying(false);
    glide(master.gain, 0, FADE_OUT);
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (playing) return;                 // started again during the fade
      clearInterval(timer);
      timer = null;
      ctx.suspend().catch(() => {});
    }, FADE_OUT * 1000 + 200);
  }

  async function toggle() {
    if (playing) stop();
    else await start();
    return playing;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (ctx && playing) glide(master.gain, volume * MAX_GAIN, 0.4);
  }

  const api = { start, stop, toggle, setVolume, isPlaying: () => playing, onchange: null };
  window.NovaAmbient = api;
})();
