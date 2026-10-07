// Nova planet generator: draws a unique planet for each Nova suite member from
// a seed (their id or handle). The planet is their identity badge.
//
// Pure and deterministic: the same seed and theme always give the same planet,
// on any machine. The seed is hashed with FNV-1a (32 bit) into one mulberry32
// random stream, and every trait is drawn from that stream in a fixed order
// (see DRAW_ORDER and the README). There is no Math.random and no Date here.
//
// This file only knows HOW to draw. Every art choice (colours, which kinds of
// planet exist and how often, glow, clouds, rings, moons, the starfield, the
// names) comes from a theme object, like themes/nova.js. A new look for the
// studio's lore is a new theme file, not a change here.
//
// Works as a plain ES module in a Cloudflare Worker, in browsers and in Node:
// no DOM, no build step. The SVG comes back as a string.
//
//   generatePlanet(seed, theme, overrides?)  -> planet (plain JSON-safe data)
//   renderPlanetSVG(planet, { size, background, animate, idPrefix, detail }) -> "<svg ...>"
//   planetToDataURI(svg)                     -> "data:image/svg+xml;charset=utf-8,..."
//   planetName(planet, theme), describePlanet(planet, theme) -> strings
//   validateOverrides(overrides, theme)      -> { overrides, errors }

/**
 * A theme: all the art direction. See themes/nova.js and the README.
 * Colours are references like "a3", "accent", "glow", "gold.3", "@frost", "#AABBCC", "a3+@white:0.4".
 * @typedef {Object} Theme
 * @property {string} id
 * @property {string} [name]
 * @property {Record<string, string>} colors fixed colours, used as "@name" (never hue-shifted)
 * @property {Record<string, string[]>} ramps named ramps of 5 stops, dark to light
 * @property {{ id: string, label: string, weight?: number, a: string, b: string, accent: string, glow: string|string[] }[]} palettes
 * @property {SurfaceKind[]} surfaces the kinds of planet
 * @property {{ light: [number, number], terminator: number, limb: number, specular: number, shade: string, specularColor: string, viewTilt: [number, number], rotation: [number, number], hueShift: [number, number] }} shading
 * @property {{ intensity: [number, number], spread: [number, number], rim: number }} glow
 * @property {{ surface: number, clouds: number, glow: number }} blur softness for a planet of radius 30
 * @property {{ padding: number, minRadius: number, maxRadius: number }} layout in a 100-unit square
 * @property {{ color: string, opacity: [number, number], count: number, thickness: [number, number], length: [number, number] }} clouds
 * @property {{ inner: [number, number], width: [number, number], shadow: number, styles: { id: string, weight?: number, colors: string[], opacity: [number, number], bands: [number, number], gaps: number }[] }} rings
 * @property {{ weights: number[], distance: [number, number], size: [number, number], colors: string[], period: [number, number], inclination: [number, number] }} moons
 * @property {{ colors: string[], latitude: number, width: number, opacity: number }} aurora
 * @property {{ latitude: [number, number], longitude: [number, number], size: [number, number] }} storm
 * @property {object[]} [motifs] { kind: "sparkle", chance, color, count, size, distance } or { kind: "orbits", chance, color, opacity }
 * @property {{ colors: string[], nebula: string[], nebulaOpacity: number, stars: string[], starCount: number[] }} background
 * @property {{ join?: string, type?: Function, palette?: Function, moons?: Function, extra?: Function, name?: Function }} [naming]
 */

/**
 * One kind of planet in a theme.
 * @typedef {Object} SurfaceKind
 * @property {string} id
 * @property {number} [weight]
 * @property {string|string[]} renderer bands | craters | continents | cracks | frost (or a list to choose from)
 * @property {string[]} [palettes] palette ids this kind likes (default: all)
 * @property {number} [rings] chance of rings, 0 to 1
 * @property {number} [storm] chance of a storm
 * @property {number} [aurora] chance of an aurora
 * @property {[number, number]} [clouds] cloud cover range
 * @property {number} [gloss] extra shine (oceans, ice)
 * @property {Record<string, string|string[]>} colors colour roles for the drawing style
 * @property {Record<string, any>} look numbers for the drawing style
 * @property {Record<string, { colors?: object, look?: object }>} [variants] changes per drawing style
 */

/**
 * A planet: plain JSON-safe data with every trait resolved. Rendering needs only this.
 * @typedef {Object} Planet
 * @property {number} version
 * @property {string} seed
 * @property {string} theme
 * @property {string} surface
 * @property {string} renderer
 * @property {string} palette
 * @property {number} paletteIndex
 * @property {number} hueShift
 * @property {number} rotation
 * @property {number} viewTilt
 * @property {Record<string, string|string[]>} colors
 * @property {{ color: string, intensity: number, spread: number, rim: number }} glow
 * @property {null|{ style: string, inner: number, outer: number, bands: object[], shadow: number }} rings
 * @property {{ angle: number, distance: number, size: number, color: string, period: number, inclination: number }[]} moons
 * @property {null|{ colors: string[], latitude: number, width: number, opacity: number }} aurora
 * @property {null|{ lat: number, lon: number, size: number }} storm
 * @property {object} clouds
 * @property {object[]} motifs
 * @property {object} background
 * @property {Record<string, number>} seeds
 * @property {object} overrides the pinned traits that were applied
 * @property {string} name
 * @property {string} description
 */

export const GENERATOR_VERSION = 1;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// How many moons a planet can have (the stream always reserves this many slots)
export const MOON_SLOTS = 3;
// Random walks (cracks) always draw this many turns, used or not
const MAX_STEPS = 12;
// How much of the full detail each detail level keeps (0 = tiny badge, 3 = hero)
const SHARE = [0.3, 0.55, 0.8, 1];

// ---------------------------------------------------------------------------
// The draw order. Every planet takes exactly these numbers from its stream, in
// this order, whatever the theme or overrides say. Pinning one trait never
// shifts the others, and a port to another language gives identical planets.
// ---------------------------------------------------------------------------
const MAIN_DRAWS = [
  "surface", "renderer", "palette", "hueShift", "rotation", "viewTilt",
  "glowColor", "glowIntensity", "glowSpread",
  "rings", "ringStyle", "ringInner", "ringWidth",
  "moonCount", "aurora", "auroraColor",
  "storm", "stormLat", "stormLon", "stormSize", "clouds",
];
const MOON_DRAWS = ["angle", "distance", "size", "color", "period", "inclination"];
const SEED_DRAWS = ["detailSeed", "cloudSeed", "ringSeed", "starSeed", "motifSeed", "nameSeed"];
export const DRAW_ORDER = [
  ...MAIN_DRAWS,
  ...Array.from({ length: MOON_SLOTS }, (_, i) => MOON_DRAWS.map((k) => `moon${i}.${k}`)).flat(),
  ...SEED_DRAWS,
];

// The drawing styles this generator knows, and the colour roles and look
// settings each one needs from the theme
const RENDERERS = {
  bands: { colors: ["base", "zones", "belts", "storm", "stormEye"], look: ["bands", "wave", "blend", "streaks", "turbulence", "drift"] },
  craters: { colors: ["base", "light", "dark", "crater", "rim"], look: ["patches", "patchSize", "craters", "craterSize"] },
  continents: { colors: ["sea", "seaDeep", "shallows", "land", "landHigh", "ice"], look: ["continents", "size", "islands", "islandSize", "deeps", "roughness", "iceCaps", "capLatitude"] },
  cracks: { colors: ["base", "plate", "crack", "core", "lava"], look: ["plates", "pools", "poolSize", "cracks", "step", "crackWidth"] },
  frost: { colors: ["base", "light", "streak", "crack"], look: ["streaks", "lineae", "cracks", "step", "iceCaps", "capLatitude"] },
};
export const RENDERER_NAMES = Object.keys(RENDERERS);

// ---------------------------------------------------------------------------
// Random numbers
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32 bit, over the UTF-8 bytes of the text.
 * @param {string} text
 * @returns {number} an unsigned 32-bit integer
 */
export function fnv1a32(text) {
  const s = String(text);
  let h = 0x811c9dc5;
  const byte = (b) => { h = Math.imul(h ^ b, 0x01000193); };
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    // Join a surrogate pair into one code point
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
    }
    if (c < 0x80) byte(c);
    else if (c < 0x800) { byte(0xc0 | (c >> 6)); byte(0x80 | (c & 63)); }
    else if (c < 0x10000) { byte(0xe0 | (c >> 12)); byte(0x80 | ((c >> 6) & 63)); byte(0x80 | (c & 63)); }
    else { byte(0xf0 | (c >> 18)); byte(0x80 | ((c >> 12) & 63)); byte(0x80 | ((c >> 6) & 63)); byte(0x80 | (c & 63)); }
  }
  return h >>> 0;
}

/**
 * mulberry32: a tiny, fast, well-mixed 32-bit generator.
 * @param {number} seed an unsigned 32-bit integer
 * @returns {() => number} gives numbers in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A number from a [min, max] range
const lerp = (range, r) => range[0] + r * (range[1] - range[0]);
// An index into a list of n things
const pickIndex = (r, n) => Math.min(n - 1, Math.floor(r * n));
// A whole 32-bit seed for a sub-stream (exact: r is a 32-bit value / 2^32)
const toSeed = (r) => Math.floor(r * 4294967296) >>> 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Pick by weight: walk the running total until it passes r * total
function pickWeightedIndex(r, weights) {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  let t = r * total;
  for (let i = 0; i < weights.length; i++) {
    t -= Math.max(0, weights[i]);
    if (t < 0) return i;
  }
  return weights.length - 1;
}
const pickWeighted = (r, items) => items[pickWeightedIndex(r, items.map((x) => x.weight ?? 1))];

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  const c = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}
const normHex = (hex) => rgbToHex(hexToRgb(hex));

/** Mix two hex colours (t = 0 gives a, t = 1 gives b). */
export function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

// Turn a colour round the colour wheel, keeping its lightness and strength
function shiftHue(hex, deg) {
  if (!deg) return normHex(hex);
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return normHex(hex);
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60 + deg) % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const part = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex([part(h + 1 / 3) * 255, part(h) * 255, part(h - 1 / 3) * 255]);
}

// Theme colours are written as small references (see the README):
//   "a0".."a4", "b0".."b4"  stops of the palette's two ramps (dark to light)
//   "accent", "glow"        the palette's accent, the planet's glow colour
//   "gold.3"                a stop of any named ramp in theme.ramps
//   "@frost"                a fixed colour from theme.colors (never hue-shifted)
//   "#AABBCC"               a literal colour (never hue-shifted)
//   "a3+@white:0.4"         a mix of two references (0 = all left, 1 = all right)
function makeResolver(theme, palette, hueShift) {
  const state = { glow: null };
  const fail = (ref) => { throw new Error(`Theme "${theme.id}": unknown colour "${ref}"`); };
  function resolve(ref) {
    if (Array.isArray(ref)) return ref.map(resolve);
    if (typeof ref !== "string") fail(ref);
    ref = ref.trim();
    const plus = ref.indexOf("+");
    if (plus > 0) {
      const [right, t] = ref.slice(plus + 1).split(":");
      return mix(resolve(ref.slice(0, plus)), resolve(right), t === undefined ? 0.5 : Number(t));
    }
    if (ref[0] === "#") return normHex(ref);
    if (ref[0] === "@") {
      const c = theme.colors && theme.colors[ref.slice(1)];
      return c ? normHex(c) : fail(ref);
    }
    if (ref === "glow") return state.glow || fail(ref);
    if (ref === "accent") return resolve(palette.accent);
    let m = /^([ab])([0-9])$/.exec(ref);
    if (m) {
      const ramp = theme.ramps[palette[m[1]]];
      return ramp && ramp[m[2]] ? shiftHue(ramp[m[2]], hueShift) : fail(ref);
    }
    m = /^([A-Za-z][\w-]*)\.([0-9])$/.exec(ref);
    if (m) {
      const ramp = theme.ramps[m[1]];
      return ramp && ramp[m[2]] ? shiftHue(ramp[m[2]], hueShift) : fail(ref);
    }
    return fail(ref);
  }
  resolve.state = state;
  return resolve;
}

// ---------------------------------------------------------------------------
// Overrides (from the database's planet_overrides): pin any trait
// ---------------------------------------------------------------------------

/**
 * Check pinned traits against the theme. Bad or unknown values are dropped
 * (and listed in errors), so a broken row never breaks a profile.
 * @param {object|string|null|undefined} overrides an object, or its JSON text
 * @param {object} theme
 * @returns {{ overrides: object, errors: string[] }}
 */
export function validateOverrides(overrides, theme) {
  const out = {};
  const errors = [];
  if (overrides == null || overrides === "") return { overrides: out, errors };
  let o = overrides;
  if (typeof o === "string") {
    try { o = JSON.parse(o); } catch (err) { return { overrides: out, errors: ["overrides are not valid JSON"] }; }
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return { overrides: out, errors: ["overrides must be an object"] };
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const maxMoons = Math.min(MOON_SLOTS, theme.moons.weights.length - 1);
  for (const [key, value] of Object.entries(o)) {
    if (value === null || value === undefined) continue;
    switch (key) {
      case "surface":
        if (theme.surfaces.some((s) => s.id === value)) out.surface = value;
        else errors.push(`surface "${value}" is not one of ${theme.surfaces.map((s) => s.id).join(", ")}`);
        break;
      case "palette":
      case "paletteIndex": {
        const i = num(value) ? value : theme.palettes.findIndex((p) => p.id === value);
        if (Number.isInteger(i) && i >= 0 && i < theme.palettes.length) out.palette = i;
        else errors.push(`palette "${value}" is not in the theme`);
        break;
      }
      case "rings":
      case "aurora":
      case "storm":
        if (typeof value === "boolean") out[key] = value;
        else errors.push(`${key} must be true or false`);
        break;
      case "moons":
        if (Number.isInteger(value) && value >= 0 && value <= maxMoons) out.moons = value;
        else errors.push(`moons must be a whole number from 0 to ${maxMoons}`);
        break;
      case "hueShift":
        if (num(value) && Math.abs(value) <= 180) out.hueShift = value;
        else errors.push("hueShift must be a number of degrees from -180 to 180");
        break;
      case "rotation":
        if (num(value) && Math.abs(value) <= 90) out.rotation = value;
        else errors.push("rotation must be a number of degrees from -90 to 90");
        break;
      case "glow":
      case "clouds":
        if (num(value) && value >= 0 && value <= 1) out[key] = value;
        else errors.push(`${key} must be a number from 0 to 1`);
        break;
      default:
        errors.push(`unknown override "${key}"`);
    }
  }
  return { overrides: out, errors };
}

// ---------------------------------------------------------------------------
// The planet: every trait, resolved into plain data
// ---------------------------------------------------------------------------

function checkTheme(theme) {
  if (!theme || !Array.isArray(theme.surfaces) || !theme.surfaces.length || !Array.isArray(theme.palettes) || !theme.palettes.length) {
    throw new TypeError("A planet needs a theme with surfaces and palettes (see themes/nova.js)");
  }
}

// A surface may change its colours and look per drawing style (for example a
// ringed planet that is sometimes a gas giant and sometimes an ice giant)
function surfaceParts(theme, surface, renderer) {
  const v = (surface.variants && surface.variants[renderer]) || {};
  const colors = { ...surface.colors, ...v.colors };
  const look = { ...surface.look, ...v.look };
  const need = RENDERERS[renderer];
  for (const role of need.colors) if (colors[role] === undefined) throw new Error(`Theme "${theme.id}": surface "${surface.id}" (${renderer}) needs colour "${role}"`);
  for (const key of need.look) if (look[key] === undefined) throw new Error(`Theme "${theme.id}": surface "${surface.id}" (${renderer}) needs look.${key}`);
  return { colors, look };
}

/**
 * Make a planet from a seed. Pure: same seed + theme (+ overrides) = same planet.
 * @param {string|number} seed usually the member's id
 * @param {object} theme the art direction, e.g. themes/nova.js
 * @param {object|string} [overrides] pinned traits, e.g. { surface: "ocean", moons: 2 }
 * @returns {object} the planet: plain data that renderPlanetSVG draws
 */
export function generatePlanet(seed, theme, overrides) {
  checkTheme(theme);
  const seedText = seed == null ? "" : String(seed);
  const next = mulberry32(fnv1a32(seedText));
  // 1. Take every number first, always in the same order
  const d = {};
  for (const key of DRAW_ORDER) d[key] = next();
  const { overrides: pin } = validateOverrides(overrides, theme);

  // 2. What kind of planet, and how it is drawn
  const surface = pin.surface !== undefined ? theme.surfaces.find((s) => s.id === pin.surface) : pickWeighted(d.surface, theme.surfaces);
  const renderers = [].concat(surface.renderer);
  const renderer = renderers[pickIndex(d.renderer, renderers.length)];
  if (!RENDERERS[renderer]) throw new Error(`Theme "${theme.id}": surface "${surface.id}" uses unknown renderer "${renderer}" (known: ${RENDERER_NAMES.join(", ")})`);
  const parts = surfaceParts(theme, surface, renderer);

  // 3. Its palette: from the ones this kind of planet likes, unless pinned
  let palette;
  if (pin.palette !== undefined) palette = theme.palettes[pin.palette];
  else {
    const liked = surface.palettes ? theme.palettes.filter((p) => surface.palettes.includes(p.id)) : theme.palettes;
    palette = pickWeighted(d.palette, liked.length ? liked : theme.palettes);
  }
  const sh = theme.shading;
  const hueShift = pin.hueShift ?? lerp(sh.hueShift, d.hueShift);
  const color = makeResolver(theme, palette, hueShift);
  const glowRefs = [].concat(palette.glow);
  const glowColor = color(glowRefs[pickIndex(d.glowColor, glowRefs.length)]);
  color.state.glow = glowColor;

  // 4. Pose and light
  const rotation = pin.rotation ?? lerp(sh.rotation, d.rotation);
  const viewTilt = lerp(sh.viewTilt, d.viewTilt);

  // 5. Colours for every role this drawing style uses
  const colors = {};
  for (const [role, ref] of Object.entries(parts.colors)) colors[role] = color(ref);
  colors.cloud = color(theme.clouds.color);
  colors.shade = color(sh.shade);
  colors.specular = color(sh.specularColor);
  colors.glow = glowColor;

  const seeds = {
    detail: toSeed(d.detailSeed), clouds: toSeed(d.cloudSeed), ring: toSeed(d.ringSeed),
    stars: toSeed(d.starSeed), motif: toSeed(d.motifSeed), name: toSeed(d.nameSeed),
  };

  // 6. Rings: their own little stream decides the bands
  let rings = null;
  if (pin.rings ?? d.rings < (surface.rings ?? 0)) {
    const style = pickWeighted(d.ringStyle, theme.rings.styles);
    const inner = lerp(theme.rings.inner, d.ringInner);
    const outer = inner + lerp(theme.rings.width, d.ringWidth);
    const rr = mulberry32(seeds.ring);
    const n = Math.max(1, Math.round(lerp(style.bands, rr())));
    const widths = [];
    let total = 0;
    for (let i = 0; i < n; i++) { const w = 0.35 + rr(); widths.push(w); total += w; }
    const bands = [];
    let r0 = inner;
    for (let i = 0; i < n; i++) {
      const r1 = r0 + (widths[i] / total) * (outer - inner);
      const pick = rr(), opacity = lerp(style.opacity, rr()), gapRoll = rr();
      const gap = i > 0 && i < n - 1 && gapRoll < style.gaps;
      if (!gap) bands.push({ r0, r1, color: color(style.colors[pickIndex(pick, style.colors.length)]), opacity });
      r0 = r1;
    }
    rings = { style: style.id, inner, outer, bands, shadow: theme.rings.shadow };
  }

  // 7. Moons
  const moonCount = pin.moons ?? Math.min(MOON_SLOTS, pickWeightedIndex(d.moonCount, theme.moons.weights));
  const moons = [];
  for (let i = 0; i < moonCount; i++) {
    const m = (k) => d[`moon${i}.${k}`];
    moons.push({
      angle: m("angle") * 360,
      distance: lerp(theme.moons.distance, m("distance")),
      size: lerp(theme.moons.size, m("size")),
      color: color(theme.moons.colors[pickIndex(m("color"), theme.moons.colors.length)]),
      period: lerp(theme.moons.period, m("period")),
      inclination: lerp(theme.moons.inclination, m("inclination")),
    });
  }

  // 8. Aurora, storm, clouds
  let aurora = null;
  if (pin.aurora ?? d.aurora < (surface.aurora ?? 0)) {
    const list = color(theme.aurora.colors);
    const start = pickIndex(d.auroraColor, list.length);
    aurora = {
      colors: list.map((_, i) => list[(start + i) % list.length]),
      latitude: theme.aurora.latitude, width: theme.aurora.width, opacity: theme.aurora.opacity,
    };
  }
  let storm = null;
  if (pin.storm ?? d.storm < (surface.storm ?? 0)) {
    storm = {
      lat: lerp(theme.storm.latitude, d.stormLat), lon: lerp(theme.storm.longitude, d.stormLon),
      size: lerp(theme.storm.size, d.stormSize),
    };
  }
  const clouds = {
    cover: pin.clouds ?? lerp(surface.clouds || [0, 0], d.clouds),
    count: theme.clouds.count, opacity: theme.clouds.opacity,
    thickness: theme.clouds.thickness, length: theme.clouds.length,
  };

  // 9. Decorative motifs (their own stream, so new motif kinds never shift the planet)
  const mr = mulberry32(seeds.motif);
  const motifs = [];
  for (const m of theme.motifs || []) {
    const roll = mr();
    if (m.kind === "sparkle") {
      const n = Math.round(lerp(m.count, mr()));
      const items = [];
      for (let i = 0; i < m.count[1]; i++) {
        const angle = mr() * 360, distance = lerp(m.distance, mr()), size = lerp(m.size, mr());
        if (i < n) items.push({ angle, distance, size });
      }
      if (roll < m.chance) motifs.push({ kind: "sparkle", color: color(m.color), items });
    } else if (m.kind === "orbits") {
      if (roll < m.chance) motifs.push({ kind: "orbits", color: color(m.color), opacity: m.opacity });
    }
  }

  const bg = theme.background;
  const planet = {
    version: GENERATOR_VERSION,
    seed: seedText,
    theme: theme.id,
    surface: surface.id,
    renderer,
    palette: palette.id,
    paletteIndex: theme.palettes.indexOf(palette),
    hueShift, rotation, viewTilt,
    colors,
    look: parts.look,
    glow: {
      color: glowColor,
      intensity: pin.glow ?? lerp(theme.glow.intensity, d.glowIntensity),
      spread: lerp(theme.glow.spread, d.glowSpread),
      rim: theme.glow.rim,
    },
    shading: { light: sh.light, terminator: sh.terminator, limb: sh.limb, specular: sh.specular, gloss: surface.gloss || 0 },
    blur: theme.blur,
    layout: theme.layout,
    clouds, rings, moons, aurora, storm, motifs,
    background: {
      colors: color(bg.colors), nebula: color(bg.nebula), nebulaOpacity: bg.nebulaOpacity,
      stars: color(bg.stars), starCount: bg.starCount,
    },
    seeds,
    overrides: pin,
  };
  planet.name = planetName(planet, theme);
  planet.description = describePlanet(planet, theme);
  return planet;
}

/**
 * The planet's proper name, from the theme's naming rules (its own stream).
 * @param {object} planet
 * @param {object} theme
 * @returns {string}
 */
export function planetName(planet, theme) {
  const naming = theme.naming || {};
  return naming.name ? String(naming.name(planet, mulberry32(planet.seeds.name))) : "";
}

/**
 * A short line for alt text and profile captions,
 * like "Ringed gas giant · magenta & gold · 2 moons".
 * @param {object} planet
 * @param {object} theme
 * @returns {string}
 */
export function describePlanet(planet, theme) {
  const naming = theme.naming || {};
  const palette = theme.palettes.find((p) => p.id === planet.palette);
  const parts = [
    naming.type ? naming.type(planet) : planet.surface,
    naming.palette ? naming.palette(planet, palette) : palette && palette.label,
    naming.moons ? naming.moons(planet.moons.length, planet) : "",
    naming.extra ? naming.extra(planet) : "",
  ];
  return parts.filter(Boolean).join(naming.join || " · ");
}

// ---------------------------------------------------------------------------
// Drawing helpers: a sphere seen from slightly above its equator
// ---------------------------------------------------------------------------

// Numbers in the SVG keep 2 decimals: crisp and small
const f = (v) => Math.round(v * 100) / 100;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Which detail level a pixel size gets: 0 for tiny badges up to 3 for the hero. */
export function detailForSize(size) {
  return size < 40 ? 0 : size < 64 ? 1 : size < 160 ? 2 : 3;
}

// The sphere is tipped towards us by viewTilt, so the north pole shows.
// Points come back as [x, y, z] on the unit disk (y down, like SVG); z > 0 is
// the side facing us.
function makeSphere(viewTiltDeg) {
  const b = viewTiltDeg * DEG, cb = Math.cos(b), sb = Math.sin(b);
  const fromXYZ = (x, y, z) => [x, -(y * cb - z * sb), y * sb + z * cb];
  const at = (lat, lon) => {
    const cl = Math.cos(lat);
    return fromXYZ(cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon));
  };
  return { cb, sb, fromXYZ, at };
}

// A point round the back is pulled onto the rim, so shapes wrap off the edge
function rim(p) {
  if (p[2] >= 0) return p;
  const len = Math.hypot(p[0], p[1]) || 1;
  return [p[0] / len, p[1] / len, 0];
}

function polyline(pts, R, closed) {
  let d = "";
  for (let i = 0; i < pts.length; i++) d += `${i ? "L" : "M"}${f(pts[i][0] * R)} ${f(pts[i][1] * R)}`;
  return closed ? d + "Z" : d;
}

// A smooth closed curve through the points (Catmull-Rom as cubic Béziers)
function smoothClosed(pts, R) {
  const n = pts.length;
  let d = `M${f(pts[0][0] * R)} ${f(pts[0][1] * R)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${f((p1[0] + (p2[0] - p0[0]) / 6) * R)} ${f((p1[1] + (p2[1] - p0[1]) / 6) * R)} ` +
      `${f((p2[0] - (p3[0] - p1[0]) / 6) * R)} ${f((p2[1] - (p3[1] - p1[1]) / 6) * R)} ${f(p2[0] * R)} ${f(p2[1] * R)}`;
  }
  return d + "Z";
}

// A line that breaks wherever it goes round the back
function brokenLine(pts, R) {
  let d = "", pen = false;
  for (const p of pts) {
    if (p[2] < 0) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${f(p[0] * R)} ${f(p[1] * R)}`;
    pen = true;
  }
  return d;
}

const circlePath = (r, cw = true) =>
  `M${f(r)} 0A${f(r)} ${f(r)} 0 1 ${cw ? 1 : 0} ${f(-r)} 0A${f(r)} ${f(r)} 0 1 ${cw ? 1 : 0} ${f(r)} 0Z`;
const mod = (x, m) => ((x % m) + m) % m;

// The part of the disk north (or south) of a line of latitude. wave(lon) nudges
// the line (radians). The outside edge runs beyond the rim, so soft filters
// never show a seam (everything is clipped to the sphere anyway).
function latRegion(S, lat, north, wave, R, samples) {
  const OUT = 1.3 * R;
  const c = (-Math.tan(lat) * S.sb) / S.cb; // the line shows where cos(lon) > c
  if (c >= 1) return north ? circlePath(OUT) : null;
  if (c <= -1) {
    const pts = [];
    for (let i = 0; i < samples; i++) {
      const lon = -Math.PI + (TAU * i) / samples;
      pts.push(rim(S.at(lat + (wave ? wave(lon) : 0), lon)));
    }
    const oval = polyline(pts, R, true);
    return north ? oval : circlePath(OUT) + oval;
  }
  const L = Math.acos(c);
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const lon = -L + (2 * L * i) / samples;
    pts.push(rim(S.at(lat + (wave ? wave(lon) : 0), lon)));
  }
  const first = pts[0], last = pts[pts.length - 1];
  const a0 = Math.atan2(first[1], first[0]), a1 = Math.atan2(last[1], last[0]);
  const span = north ? mod(a1 - a0, TAU) : mod(a0 - a1, TAU);
  return polyline(pts, R, false) +
    `L${f(Math.cos(a1) * OUT)} ${f(Math.sin(a1) * OUT)}` +
    `A${f(OUT)} ${f(OUT)} 0 ${span > Math.PI ? 1 : 0} ${north ? 0 : 1} ${f(Math.cos(a0) * OUT)} ${f(Math.sin(a0) * OUT)}Z`;
}

// A line of latitude (open arc, or a closed oval when all of it shows)
function latLine(S, lat, R, samples) {
  const c = (-Math.tan(lat) * S.sb) / S.cb;
  if (c >= 1) return "";
  const full = c <= -1;
  const L = full ? Math.PI : Math.acos(c);
  const pts = [];
  for (let i = 0; i <= samples; i++) pts.push(rim(S.at(lat, -L + (2 * L * i) / samples)));
  return polyline(full ? pts.slice(0, -1) : pts, R, full);
}

// A streak along a line of latitude, thickest in the middle and tapering away
function swath(S, s, R, samples, lonShift = 0) {
  const top = [], bottom = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const lon = s.lon + lonShift + t * s.length;
    const w = s.thick * Math.pow(Math.sin(Math.PI * t), 0.8);
    const wl = s.wave ? s.wave * Math.sin(s.freq * lon + s.phase) : 0;
    top.push(rim(S.at(s.lat + wl + w, lon)));
    bottom.push(rim(S.at(s.lat + wl - w, lon)));
  }
  return smoothClosed(top.concat(bottom.slice(1, -1).reverse()), R);
}

// A rounded, irregular patch: a circle in lat/lon with a few smooth wobbles
function drawBlob(rand, sizeRange, rough) {
  const u = rand(), v = rand(), s = rand();
  const h = [];
  for (let k = 0; k < 4; k++) h.push([(rand() * rough) / (k + 1), rand() * TAU]);
  return { lat: Math.asin(2 * u - 1) * 0.92, lon: (v - 0.5) * 190 * DEG, size: lerp(sizeRange, s) * DEG, h };
}
function blobPath(S, b, R, points, scale = 1, stretch = 1) {
  if (S.at(b.lat, b.lon)[2] < -0.05) return "";
  const pts = [];
  const squeeze = Math.max(0.25, Math.cos(b.lat));
  for (let j = 0; j < points; j++) {
    const th = (TAU * j) / points;
    let r = 1;
    for (let k = 0; k < 4; k++) r += b.h[k][0] * Math.sin((k + 2) * th + b.h[k][1]);
    r *= b.size * scale;
    pts.push(rim(S.at(b.lat + r * Math.sin(th), b.lon + (r * Math.cos(th) * stretch) / squeeze)));
  }
  return smoothClosed(pts, R);
}

// A wandering crack: a random walk over the sphere (always MAX_STEPS turns drawn)
function drawWalk(rand, stepsRange) {
  const u = rand(), v = rand(), heading = rand() * TAU, steps = Math.round(lerp(stepsRange, rand()));
  const turns = [];
  for (let i = 0; i < MAX_STEPS; i++) turns.push((rand() - 0.5) * 1.0);
  const width = rand();
  return { lat: Math.asin(2 * u - 1) * 0.9, lon: (v - 0.5) * 170 * DEG, heading, steps: Math.min(MAX_STEPS, steps), turns, width };
}
function walkPoints(S, w, stepDeg) {
  let lat = w.lat, lon = w.lon, head = w.heading;
  const pts = [S.at(lat, lon)];
  for (let i = 0; i < w.steps; i++) {
    head += w.turns[i];
    lat = clamp(lat + Math.sin(head) * stepDeg * DEG, -1.45, 1.45);
    lon += (Math.cos(head) * stepDeg * DEG) / Math.max(0.3, Math.cos(lat));
    pts.push(S.at(lat, lon));
  }
  return pts;
}

// A long, slightly wavy arc of a great circle (the cracks across an ice moon)
function drawArc(rand) {
  return { u: rand() * 2 - 1, theta: rand() * TAU, t0: rand() * TAU, span: (60 + rand() * 150) * DEG, wobble: rand() * 0.05, freq: 3 + Math.floor(rand() * 6), phase: rand() * TAU, width: rand() };
}
function arcPoints(S, g, samples) {
  const s = Math.sqrt(1 - g.u * g.u);
  const p = [s * Math.cos(g.theta), g.u, s * Math.sin(g.theta)];
  const a = Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1 = [p[1] * a[2] - p[2] * a[1], p[2] * a[0] - p[0] * a[2], p[0] * a[1] - p[1] * a[0]];
  const n1 = Math.hypot(...e1);
  e1 = e1.map((v) => v / n1);
  const e2 = [p[1] * e1[2] - p[2] * e1[1], p[2] * e1[0] - p[0] * e1[2], p[0] * e1[1] - p[1] * e1[0]];
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = g.t0 + (g.span * i) / samples;
    const wob = g.wobble * Math.sin(g.freq * t + g.phase);
    const v = [0, 1, 2].map((k) => e1[k] * Math.cos(t) + e2[k] * Math.sin(t) + p[k] * wob);
    const len = Math.hypot(...v);
    pts.push(S.fromXYZ(v[0] / len, v[1] / len, v[2] / len));
  }
  return pts;
}

// Keep the first share of a list for this detail level
const take = (list, detail, min = 1) => list.slice(0, Math.min(list.length, Math.max(min, Math.round(list.length * SHARE[detail]))));

// Filters are made once per SVG, on first use
function blurFilter(ctx, name, std) {
  const key = `${ctx.id}-${name}`;
  if (!ctx.filters.has(key)) {
    ctx.filters.add(key);
    ctx.defs.push(`<filter id="${key}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${f(std)}"/></filter>`);
  }
  return `filter="url(#${key})"`;
}
// Blur amounts in the theme are for a planet of radius 30
const soft = (ctx, which) => (ctx.p.blur[which] * ctx.R) / 30;

// ---------------------------------------------------------------------------
// Surfaces. Each one takes its own numbers from the detail stream, always the
// full list (the badge simply draws fewer of them), and returns markup for
// under the shading ("under") and glowing over it ("emit").
// ---------------------------------------------------------------------------

// Banded gas giant: zones and belts, wavy edges, thin streaks, swirls
function renderBands(ctx) {
  const { p, S, R, detail, animate } = ctx;
  const rand = mulberry32(p.seeds.detail);
  const look = p.look, c = p.colors;
  const n = Math.max(3, Math.round(lerp(look.bands, rand())));
  const all = [];
  for (let i = 0; i < n; i++) {
    const jitter = rand(), pick = rand(), blend = rand(), amp = rand(), freq = rand(), phase = rand(), weight = rand(), speed = rand();
    const t = (i + 0.2 + jitter * 0.6) / n;
    const list = i % 2 ? c.belts : c.zones;
    all.push({
      lat: Math.asin(clamp(1 - 2 * t, -0.985, 0.985)),
      color: mix(list[pickIndex(pick, list.length)], c.base, blend * look.blend),
      amp: lerp(look.wave, amp) * DEG, freq: 2 + Math.floor(freq * 6), phase: phase * TAU,
      weight, dir: speed < 0.5 ? -1 : 1, period: lerp(look.drift, (speed * 2) % 1),
    });
  }
  const streaks = [];
  for (let i = 0; i < look.streaks; i++) {
    const u = rand(), lon = rand(), len = rand(), thick = rand(), pick = rand(), op = rand(), tone = rand();
    const list = tone < 0.5 ? c.zones : c.belts;
    streaks.push({ lat: Math.asin(2 * u - 1) * 0.9, lon: (lon - 0.5) * 200 * DEG, length: (50 + len * 120) * DEG, thick: (0.5 + thick * 1.6) * DEG, color: list[pickIndex(pick, list.length)], opacity: 0.25 + op * 0.4 });
  }
  // The badge keeps the strongest edges, still north to south
  const keep = Math.max(3, Math.round(n * SHARE[detail]));
  const chosen = all.map((b, i) => [b.weight, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, keep).map((x) => x[1]).sort((a, b) => a - b).map((i) => all[i]);
  const samples = [12, 18, 30, 44][detail];
  const waveScale = [0, 0.6, 1, 1][detail];

  let g = `<circle r="${f(R * 1.3)}" fill="${c.base}"/>`;
  for (const b of chosen) {
    const wave = (shift) => (b.amp * waveScale ? (lon) => b.amp * waveScale * Math.sin(b.freq * lon + b.phase + shift) : null);
    const d0 = latRegion(S, b.lat, false, wave(0), R, samples);
    if (!d0) continue;
    let anim = "";
    if (animate && b.amp > 0) {
      const frames = [];
      for (let j = 0; j <= 8; j++) frames.push(latRegion(S, b.lat, false, wave((b.dir * TAU * j) / 8), R, samples));
      anim = `<animate attributeName="d" dur="${f(b.period)}s" repeatCount="indefinite" values="${frames.join(";")}"/>`;
    }
    g += `<path d="${d0}" fill="${b.color}" fill-rule="evenodd">${anim}</path>`;
  }
  if (detail >= 2) {
    for (const s of take(streaks, detail)) g += `<path d="${swath(S, s, R, 12)}" fill="${s.color}" fill-opacity="${f(s.opacity)}"/>`;
  }
  // Soft edges, and a gentle swirl on big sizes
  let filter = "";
  if (detail >= 1) {
    const key = `${ctx.id}-bands`;
    const swirl = detail >= 3 && look.turbulence > 0;
    ctx.defs.push(
      `<filter id="${key}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">` +
      (swirl
        ? `<feTurbulence type="fractalNoise" baseFrequency="${(1.1 / R).toFixed(4)} ${(4.5 / R).toFixed(4)}" numOctaves="2" seed="${p.seeds.detail % 9973}" result="n"/>` +
          `<feDisplacementMap in="SourceGraphic" in2="n" scale="${f((look.turbulence * R) / 30)}" xChannelSelector="R" yChannelSelector="G" result="d"/>`
        : "") +
      `<feGaussianBlur stdDeviation="${f(soft(ctx, "surface"))}"/></filter>`
    );
    filter = ` filter="url(#${key})"`;
  }
  return { under: `<g${filter}>${g}</g>` + renderStorm(ctx), emit: "" };
}

// Cratered rock: soft darker and lighter plains, then craters lit from one side
function renderCraters(ctx) {
  const { p, S, R, detail } = ctx;
  const rand = mulberry32(p.seeds.detail);
  const look = p.look, c = p.colors;
  const patches = [];
  for (let i = 0; i < look.patches; i++) { const b = drawBlob(rand, look.patchSize, 0.55); b.tone = rand(); patches.push(b); }
  const craters = [];
  for (let i = 0; i < look.craters; i++) {
    const u = rand(), v = rand(), s = rand(), tone = rand();
    craters.push({ lat: Math.asin(2 * u - 1), lon: (v - 0.5) * 190 * DEG, size: lerp(look.craterSize, Math.pow(s, 2.4)) * DEG, tone, i });
  }
  craters.sort((a, b) => b.size - a.size || a.i - b.i);
  const points = [8, 10, 14, 18][detail];

  let g = `<circle r="${f(R * 1.3)}" fill="${c.base}"/>`;
  let pg = "";
  for (const b of take(patches, detail, 2)) {
    const d = blobPath(S, b, R, points);
    if (d) pg += `<path d="${d}" fill="${b.tone < 0.5 ? c.dark : c.light}" fill-opacity="${f(0.35 + b.tone * 0.3)}"/>`;
  }
  g += `<g ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))}>${pg}</g>`;
  const [lx, ly] = ctx.lightLocal;
  for (const k of take(craters, detail, 3)) {
    const P = S.at(k.lat, k.lon);
    if (P[2] < 0.12) continue;
    const sz = k.size * R * (detail === 0 ? 1.3 : 1);
    const ang = f((Math.atan2(P[1], P[0]) * 180) / Math.PI);
    const x = P[0] * R, y = P[1] * R, rx = sz * P[2], ry = sz;
    const op = 0.55 + k.tone * 0.35;
    g += `<ellipse cx="${f(x - lx * sz * 0.2)}" cy="${f(y - ly * sz * 0.2)}" rx="${f(rx * 1.05)}" ry="${f(ry * 1.05)}" transform="rotate(${ang} ${f(x - lx * sz * 0.2)} ${f(y - ly * sz * 0.2)})" fill="${c.rim}" fill-opacity="${f(op * 0.8)}"/>`;
    g += `<ellipse cx="${f(x + lx * sz * 0.08)}" cy="${f(y + ly * sz * 0.08)}" rx="${f(rx * 0.92)}" ry="${f(ry * 0.92)}" transform="rotate(${ang} ${f(x + lx * sz * 0.08)} ${f(y + ly * sz * 0.08)})" fill="${c.crater}" fill-opacity="${f(op)}"/>`;
  }
  return { under: g + renderStorm(ctx), emit: "" };
}

// Ocean world: deep water, shallows, continents with highlands, ice caps
function renderContinents(ctx) {
  const { p, S, R, detail } = ctx;
  const rand = mulberry32(p.seeds.detail);
  const look = p.look, c = p.colors;
  const count = Math.round(lerp(look.continents, rand()));
  const lands = [];
  for (let i = 0; i < look.continents[1]; i++) { const b = drawBlob(rand, look.size, look.roughness); if (i < count) lands.push(b); }
  const isles = [];
  for (let i = 0; i < look.islands; i++) isles.push(drawBlob(rand, look.islandSize, look.roughness));
  const deeps = [];
  for (let i = 0; i < look.deeps; i++) deeps.push(drawBlob(rand, look.size, 0.3));
  const capRoll = rand(), capN = lerp(look.capLatitude, rand()), capS = lerp(look.capLatitude, rand()), capAmp = rand(), capPhase = rand() * TAU;
  const points = [8, 10, 14, 18][detail];

  let g = `<circle r="${f(R * 1.3)}" fill="${c.sea}"/>`;
  if (detail >= 2) {
    let dg = "";
    for (const b of deeps) { const d = blobPath(S, b, R, points); if (d) dg += `<path d="${d}" fill="${c.seaDeep}" fill-opacity="0.6"/>`; }
    g += `<g ${blurFilter(ctx, "glowb", soft(ctx, "glow"))}>${dg}</g>`;
  }
  const shapes = lands.concat(take(isles, detail, 0));
  if (detail >= 1) {
    let sg = "";
    for (const b of shapes) { const d = blobPath(S, b, R, points, 1.22); if (d) sg += `<path d="${d}" fill="${c.shallows}" fill-opacity="0.55"/>`; }
    g += `<g ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))}>${sg}</g>`;
  }
  let lg = "";
  for (const b of shapes) {
    const d = blobPath(S, b, R, points);
    if (!d) continue;
    lg += `<path d="${d}" fill="${c.land}"/>`;
    if (detail >= 2) { const h = blobPath(S, b, R, points, 0.55); if (h) lg += `<path d="${h}" fill="${c.landHigh}" fill-opacity="0.8"/>`; }
  }
  g += detail >= 1 ? `<g ${blurFilter(ctx, "surface", soft(ctx, "surface"))}>${lg}</g>` : lg;
  if (capRoll < look.iceCaps) {
    const wave = detail ? (lon) => capAmp * 4 * DEG * Math.sin(5 * lon + capPhase) : null;
    const north = latRegion(S, capN * DEG, true, wave, R, [14, 20, 32, 44][detail]);
    const south = latRegion(S, -capS * DEG, false, wave, R, [14, 20, 32, 44][detail]);
    g += `<g ${blurFilter(ctx, "surface", soft(ctx, "surface"))} fill="${c.ice}" fill-opacity="0.92">${north ? `<path d="${north}"/>` : ""}${south ? `<path d="${south}" fill-rule="evenodd"/>` : ""}</g>`;
  }
  return { under: g, emit: "" };
}

// Molten world: dark cooling crust, glowing cracks and lava pools (they glow on the night side too)
function renderCracks(ctx) {
  const { p, S, R, detail, animate } = ctx;
  const rand = mulberry32(p.seeds.detail);
  const look = p.look, c = p.colors;
  const plates = [];
  for (let i = 0; i < look.plates; i++) { const b = drawBlob(rand, [14, 30], 0.5); b.tone = rand(); plates.push(b); }
  const pools = [];
  for (let i = 0; i < look.pools; i++) pools.push(drawBlob(rand, look.poolSize, 0.45));
  const cracks = [];
  for (let i = 0; i < look.cracks; i++) cracks.push(drawWalk(rand, [4, MAX_STEPS]));
  const points = [8, 10, 14, 18][detail];
  const wScale = ((detail === 0 ? 1.7 : detail === 1 ? 1.25 : 1) * R) / 30;

  let g = `<circle r="${f(R * 1.3)}" fill="${c.base}"/>`;
  let pg = "";
  for (const b of take(plates, detail, 2)) { const d = blobPath(S, b, R, points); if (d) pg += `<path d="${d}" fill="${c.plate}" fill-opacity="${f(0.45 + b.tone * 0.45)}"/>`; }
  g += `<g ${blurFilter(ctx, "surface", soft(ctx, "surface"))}>${pg}</g>`;

  let pools1 = "", pools2 = "", glow = "", core = "";
  for (const b of take(pools, detail, 1)) {
    const d = blobPath(S, b, R, points);
    if (!d) continue;
    pools1 += `<path d="${d}" fill="${c.lava}"/>`;
    const d2 = blobPath(S, b, R, points, 0.5);
    if (d2) pools2 += `<path d="${d2}" fill="${c.core}" fill-opacity="0.7"/>`;
  }
  for (const w of take(cracks, detail, 3)) {
    const d = brokenLine(walkPoints(S, w, look.step), R);
    if (!d) continue;
    const width = lerp(look.crackWidth, w.width) * wScale;
    glow += `<path d="${d}" stroke-width="${f(width * 3.2)}"/>`;
    core += `<path d="${d}" stroke-width="${f(width * 0.75)}"/>`;
  }
  const pulse = animate ? `<animate attributeName="opacity" values="0.78;1;0.78" dur="5.5s" repeatCount="indefinite"/>` : "";
  const emit =
    `<g>${pulse}` +
    `<g ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))} fill-opacity="0.85">${pools1}</g>` +
    `<g fill="none" stroke="${c.crack}" stroke-opacity="0.75" stroke-linecap="round" stroke-linejoin="round" ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))}>${glow}</g>` +
    `<g ${blurFilter(ctx, "surface", soft(ctx, "surface"))}>${pools2}</g>` +
    `<g fill="none" stroke="${c.core}" stroke-opacity="0.95" stroke-linecap="round" stroke-linejoin="round">${core}</g>` +
    `</g>`;
  return { under: g + renderStorm(ctx), emit };
}

// Icy world: pale, with soft streaks, long crossing lines and fine cracks
function renderFrost(ctx) {
  const { p, S, R, detail } = ctx;
  const rand = mulberry32(p.seeds.detail);
  const look = p.look, c = p.colors;
  const streaks = [];
  for (let i = 0; i < look.streaks; i++) {
    const u = rand(), lon = rand(), len = rand(), thick = rand(), tone = rand(), op = rand(), wave = rand();
    streaks.push({ lat: Math.asin(2 * u - 1) * 0.85, lon: (lon - 0.5) * 200 * DEG, length: (60 + len * 140) * DEG, thick: (1.5 + thick * 5) * DEG, tone, opacity: 0.25 + op * 0.4, wave: wave * 3 * DEG, freq: 3, phase: wave * TAU });
  }
  const arcs = [];
  for (let i = 0; i < look.lineae; i++) arcs.push(drawArc(rand));
  const cracks = [];
  for (let i = 0; i < look.cracks; i++) cracks.push(drawWalk(rand, [3, 9]));
  const capRoll = rand(), capLat = lerp(look.capLatitude, rand());
  const wScale = ((detail === 0 ? 1.8 : detail === 1 ? 1.3 : 1) * R) / 30;

  let g = `<circle r="${f(R * 1.3)}" fill="${c.base}"/>`;
  let sg = "";
  for (const s of take(streaks, detail, 2)) sg += `<path d="${swath(S, s, R, [6, 8, 12, 14][detail])}" fill="${s.tone < 0.6 ? c.light : c.streak}" fill-opacity="${f(s.tone < 0.6 ? s.opacity : s.opacity * 0.5)}"/>`;
  if (capRoll < look.iceCaps) {
    const cap = latRegion(S, capLat * DEG, true, null, R, [14, 20, 32, 44][detail]);
    if (cap) sg += `<path d="${cap}" fill="${c.light}" fill-opacity="0.85"/>`;
  }
  g += `<g ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))}>${sg}</g>`;
  let lg = "";
  for (const a of take(arcs, detail, 2)) {
    const d = brokenLine(arcPoints(S, a, [10, 16, 28, 40][detail]), R);
    if (d) lg += `<path d="${d}" stroke-width="${f((0.25 + a.width * 0.45) * wScale)}"/>`;
  }
  g += `<g fill="none" stroke="${c.streak}" stroke-opacity="0.5" stroke-linecap="round" stroke-linejoin="round"${detail >= 1 ? " " + blurFilter(ctx, "fine", soft(ctx, "surface") * 0.6) : ""}>${lg}</g>`;
  if (detail >= 1) {
    let cg = "";
    for (const w of take(cracks, detail, 0)) { const d = brokenLine(walkPoints(S, w, look.step), R); if (d) cg += `<path d="${d}" stroke-width="${f((0.2 + w.width * 0.3) * wScale)}"/>`; }
    g += `<g fill="none" stroke="${c.crack}" stroke-opacity="0.55" stroke-linecap="round" stroke-linejoin="round">${cg}</g>`;
  }
  return { under: g + renderStorm(ctx), emit: "" };
}

const SURFACE_RENDERERS = { bands: renderBands, craters: renderCraters, continents: renderContinents, cracks: renderCracks, frost: renderFrost };

// A storm: an oval vortex on a gas giant, a spiral of cloud anywhere else
function renderStorm(ctx) {
  const { p, S, R, detail } = ctx;
  const st = p.storm;
  if (!st || detail === 0) return "";
  const lat = st.lat * DEG, lon = st.lon * DEG, size = st.size * DEG;
  const points = [10, 12, 16, 20][detail];
  if (p.renderer === "bands") {
    const b = { lat, lon, size, h: [[0.04, 0], [0.03, 1], [0, 0], [0, 0]] };
    const outer = blobPath(S, b, R, points, 1.45, 1.8);
    const mid = blobPath(S, b, R, points, 1, 1.8);
    const eye = blobPath(S, b, R, points, 0.5, 1.8);
    if (!mid) return "";
    return `<g ${blurFilter(ctx, "surface", soft(ctx, "surface"))}><path d="${outer}" fill="${p.colors.storm}" fill-opacity="0.25"/>` +
      `<path d="${mid}" fill="${p.colors.storm}" fill-opacity="0.75"/><path d="${eye}" fill="${p.colors.stormEye}" fill-opacity="0.6"/></g>`;
  }
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28, a = t * 3.4 * Math.PI, r = size * 1.3 * Math.pow(t, 0.85);
    pts.push(S.at(lat + r * Math.sin(a), lon + (r * Math.cos(a)) / Math.max(0.3, Math.cos(lat))));
  }
  const d = brokenLine(pts, R);
  if (!d) return "";
  return `<path d="${d}" fill="none" stroke="${p.colors.cloud}" stroke-opacity="0.85" stroke-width="${f(size * R * 0.55)}" stroke-linecap="round" ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))}/>`;
}

// Clouds: soft streaks along the latitudes, drifting round the planet when animated
function renderClouds(ctx) {
  const { p, S, R, detail, animate } = ctx;
  const cl = p.clouds;
  if (!(cl.cover > 0.02)) return "";
  const rand = mulberry32(p.seeds.clouds);
  const items = [];
  for (let i = 0; i < cl.count; i++) {
    const u = rand(), lon = rand(), len = rand(), thick = rand(), amp = rand(), freq = rand(), phase = rand(), op = rand();
    items.push({
      lat: Math.asin(2 * u - 1) * 0.9, lon: (lon - 0.5) * 220 * DEG, length: lerp(cl.length, len) * DEG,
      thick: lerp(cl.thickness, thick) * DEG, wave: amp * 4 * DEG, freq: 2 + Math.floor(freq * 4), phase: phase * TAU,
      opacity: lerp(cl.opacity, op), dir: op < 0.5 ? -1 : 1,
    });
  }
  const n = Math.round(cl.count * cl.cover * SHARE[detail]);
  if (!n) return "";
  const samples = [6, 8, 10, 12][detail];
  let g = "";
  for (const s of items.slice(0, n)) {
    let anim = "";
    if (animate) {
      const frames = [];
      for (let j = 0; j <= 12; j++) frames.push(swath(S, s, R, samples, (s.dir * TAU * j) / 12));
      anim = `<animate attributeName="d" dur="${f(160 + s.opacity * 120)}s" repeatCount="indefinite" values="${frames.join(";")}"/>`;
    }
    g += `<path d="${swath(S, s, R, samples)}" fill-opacity="${f(s.opacity)}">${anim}</path>`;
  }
  return `<g fill="${p.colors.cloud}" ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))}>${g}</g>`;
}

// Aurora: a glowing oval round the visible pole
function renderAurora(ctx) {
  const { p, S, R, detail, animate } = ctx;
  const a = p.aurora;
  if (!a || detail === 0) return "";
  const lat = a.latitude * DEG;
  const d1 = latLine(S, lat, R, 40), d2 = latLine(S, lat + a.width * 0.6 * DEG, R, 40);
  if (!d1) return "";
  const w = (a.width * DEG * R);
  const flicker = animate ? `<animate attributeName="opacity" values="${f(a.opacity * 0.7)};${f(a.opacity)};${f(a.opacity * 0.8)};${f(a.opacity * 0.7)}" dur="7s" repeatCount="indefinite"/>` : "";
  return `<g fill="none" opacity="${f(a.opacity)}" stroke-linecap="round">${flicker}` +
    `<path d="${d1}" stroke="${a.colors[0]}" stroke-width="${f(w * 1.7)}" stroke-opacity="0.7" ${blurFilter(ctx, "clouds", soft(ctx, "clouds"))}/>` +
    `<path d="${d2}" stroke="${a.colors[1] || a.colors[0]}" stroke-width="${f(w * 0.55)}" stroke-opacity="0.8" ${blurFilter(ctx, "surface", soft(ctx, "surface"))}/>` +
    `</g>`;
}

// Rings: bands of an annulus, seen at the same tilt as the planet. The whole
// ring is drawn behind the sphere; then the near half is drawn again, only
// where it crosses in front of the sphere (so there is never a seam).
// Small badges pull the rings in closer, so the planet itself stays big.
const RING_REACH = [0.62, 0.82, 1, 1];
const ringRadius = (r, detail) => 1 + (r - 1) * RING_REACH[detail];

function renderRings(ctx) {
  const { p, R, id, detail } = ctx;
  const rg = p.rings;
  if (!rg) return { back: "", front: "", shadow: "" };
  const k = Math.max(0.05, Math.sin(p.viewTilt * DEG));
  const annulus = (b) => circlePath(ringRadius(b.r1, detail) * R, true) + circlePath(ringRadius(b.r0, detail) * R, false);
  // Small badges merge thin bands into a few clear ones
  let bands = rg.bands;
  if (detail === 0 && bands.length > 2) {
    const half = Math.floor(bands.length / 2);
    bands = [{ ...bands[0], r1: bands[half - 1].r1 }, { ...bands[half], r1: bands[bands.length - 1].r1 }]
      .map((b) => ({ ...b, opacity: Math.min(1, b.opacity + 0.25) }));
  }
  const material = bands.map(annulus).join("");
  const [lx, ly] = ctx.lightLocal;
  const reach = ringRadius(rg.outer, detail) * R;
  const side = lx <= 0 ? 1 : -1;
  ctx.defs.push(
    `<clipPath id="${id}-rm"><path d="${material}"/></clipPath>`,
    `<clipPath id="${id}-rf"><rect x="-400" y="0" width="800" height="400"/></clipPath>`,
    `<clipPath id="${id}-rp"><circle r="${f(R)}"/></clipPath>`,
    `<linearGradient id="${id}-rl" gradientUnits="userSpaceOnUse" x1="${f(lx * reach)}" y1="${f((ly * reach) / k)}" x2="${f(-lx * reach)}" y2="${f((-ly * reach) / k)}">` +
      `<stop offset="0" stop-color="${p.colors.specular}" stop-opacity="0.16"/><stop offset="0.5" stop-color="${p.colors.shade}" stop-opacity="0"/><stop offset="1" stop-color="${p.colors.shade}" stop-opacity="0.45"/></linearGradient>`,
    // The planet's shadow on the far rings: strongest by the planet, fading outwards
    `<linearGradient id="${id}-rs" gradientUnits="userSpaceOnUse" x1="${f(side * R * 0.8)}" y1="0" x2="${f(side * reach)}" y2="0">` +
      `<stop offset="0" stop-color="${p.colors.shade}" stop-opacity="0.6"/><stop offset="1" stop-color="${p.colors.shade}" stop-opacity="0.12"/></linearGradient>`
  );
  const body = bands.map((b) => `<path d="${annulus(b)}" fill="${b.color}" fill-opacity="${f(b.opacity)}"/>`).join("") +
    `<rect x="${f(-reach)}" y="${f(-reach)}" width="${f(reach * 2)}" height="${f(reach * 2)}" fill="url(#${id}-rl)" clip-path="url(#${id}-rm)"/>`;
  const frame = `rotate(${f(p.rotation)}) scale(1 ${f(k)})`;
  // The shadow is a soft-edged band behind the planet, on the side away from the light
  const shadow = detail >= 1
    ? `<g clip-path="url(#${id}-rm)"><path d="M0 ${f(-R * 0.15)}L0 ${f(-R)}L${f(side * reach)} ${f(-R * 1.2)}L${f(side * reach)} ${f(-R * 0.1)}Z" fill="url(#${id}-rs)" ${blurFilter(ctx, "surface", soft(ctx, "surface") * 2)}/></g>`
    : "";
  const back = `<g transform="${frame}">${body}${shadow}</g>`;
  const front = `<g clip-path="url(#${id}-rp)"><g transform="${frame}"><g clip-path="url(#${id}-rf)">${body}</g></g></g>`;
  // ...and the rings' shadow falls on the planet
  const dy = -ly * R * 0.16;
  const onPlanet = detail >= 2 && rg.shadow > 0
    ? `<g transform="translate(0 ${f(dy)}) scale(1 ${f(k)})" opacity="${f(rg.shadow)}"><g clip-path="url(#${id}-rf)"><path d="${material}" fill="${p.colors.shade}"/></g></g>`
    : "";
  return { back, front, shadow: onPlanet };
}

// Moons: small shaded spheres on tilted orbits. A moon is drawn behind the
// planet on the far half of its orbit and in front on the near half.
function renderMoons(ctx, moons, orbits) {
  const { p, R, id, animate } = ctx;
  const [lx, ly] = ctx.light;
  let back = "", front = "";
  moons.forEach((m, i) => {
    const k = Math.sin(clamp(p.viewTilt + m.inclination, 5, 80) * DEG);
    const rot = p.rotation + m.inclination * 0.6;
    const a = m.distance * R, b = a * k, r = Math.max(m.size * R, 1.2);
    const cr = Math.cos(rot * DEG), sr = Math.sin(rot * DEG);
    const at = (x, y) => [x * cr - y * sr, x * sr + y * cr];
    ctx.defs.push(
      `<radialGradient id="${id}-m${i}" cx="0.5" cy="0.5" r="0.5" fx="${f(0.5 + lx * 0.32)}" fy="${f(0.5 + ly * 0.32)}">` +
        `<stop offset="0" stop-color="${mix(m.color, p.colors.specular, 0.35)}"/><stop offset="0.55" stop-color="${m.color}"/><stop offset="1" stop-color="${mix(m.color, p.colors.shade, 0.7)}"/></radialGradient>`,
      `<clipPath id="${id}-mf${i}"><rect x="-200" y="0" width="400" height="200" transform="rotate(${f(rot)})"/></clipPath>`
    );
    const ball = `<circle r="${f(r)}" fill="url(#${id}-m${i})"/><circle r="${f(r)}" fill="none" stroke="${p.glow.color}" stroke-opacity="0.35" stroke-width="${f(r * 0.12)}"/>`;
    const trail = orbits ? `<ellipse rx="${f(a)}" ry="${f(b)}" transform="rotate(${f(rot)})" fill="none" stroke="${orbits.color}" stroke-opacity="${f(orbits.opacity)}" stroke-width="${f(R * 0.012 + 0.15)}"/>` : "";
    if (animate) {
      const [x0, y0] = at(a, 0), [x1, y1] = at(-a, 0);
      const path = `M${f(x0)} ${f(y0)}A${f(a)} ${f(b)} ${f(rot)} 0 1 ${f(x1)} ${f(y1)}A${f(a)} ${f(b)} ${f(rot)} 0 1 ${f(x0)} ${f(y0)}`;
      const motion = `<animateMotion dur="${f(m.period)}s" begin="${f((-m.angle / 360) * m.period)}s" repeatCount="indefinite" path="${path}"/>`;
      back += trail + `<g>${motion}${ball}</g>`;
      front += `<g clip-path="url(#${id}-mf${i})">${trail}<g>${motion}${ball}</g></g>`;
    } else {
      const t = m.angle * DEG;
      const [x, y] = at(a * Math.cos(t), b * Math.sin(t));
      const moon = `<g transform="translate(${f(x)} ${f(y)})">${ball}</g>`;
      back += trail;
      if (trail) front += `<g clip-path="url(#${id}-mf${i})">${trail}</g>`;
      if (Math.sin(t) < 0) back += moon;
      else front += moon;
    }
  });
  return { back, front };
}

// The starfield behind the planet (only with background: true)
function renderBackground(ctx, sizePx) {
  const { p, id, detail, animate } = ctx;
  const bg = p.background;
  const rand = mulberry32(p.seeds.stars);
  ctx.defs.push(`<radialGradient id="${id}-bg" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="75"><stop offset="0" stop-color="${bg.colors[0]}"/><stop offset="1" stop-color="${bg.colors[bg.colors.length - 1]}"/></radialGradient>`);
  let s = `<rect x="-50" y="-50" width="100" height="100" fill="url(#${id}-bg)"/>`;
  let neb = "";
  for (let i = 0; i < 2; i++) {
    const x = (rand() - 0.5) * 80, y = (rand() - 0.5) * 80, rx = 18 + rand() * 22, ry = rx * (0.35 + rand() * 0.45);
    const col = bg.nebula[pickIndex(rand(), bg.nebula.length)], ang = rand() * 180;
    neb += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(rx)}" ry="${f(ry)}" transform="rotate(${f(ang)} ${f(x)} ${f(y)})" fill="${col}"/>`;
  }
  if (detail >= 1) s += `<g opacity="${f(bg.nebulaOpacity)}" ${blurFilter(ctx, "neb", 9)}>${neb}</g>`;
  const most = Math.max(...bg.starCount), n = bg.starCount[detail];
  const px = 100 / sizePx;
  let stars = "";
  for (let i = 0; i < most; i++) {
    const x = (rand() - 0.5) * 100, y = (rand() - 0.5) * 100, sz = rand(), col = rand(), bright = rand(), tw = rand();
    if (i >= n) continue;
    const r = (0.45 + Math.pow(sz, 3) * 1.25) * px * (sizePx > 300 ? 1.4 : 1);
    const fill = bg.stars[pickIndex(col, bg.stars.length)];
    const op = f(0.35 + bright * 0.65);
    const twinkle = animate && tw < 0.3 ? `<animate attributeName="opacity" values="${op};${f(op * 0.25)};${op}" dur="${f(2.5 + tw * 12)}s" repeatCount="indefinite"/>` : "";
    stars += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}" opacity="${op}">${twinkle}</circle>`;
    if (sz > 0.93 && detail >= 3) {
      const g = r * 5;
      stars += `<path d="M${f(x - g)} ${f(y)}H${f(x + g)}M${f(x)} ${f(y - g)}V${f(y + g)}" stroke="${fill}" stroke-opacity="${f(op * 0.5)}" stroke-width="${f(r * 0.35)}"/>`;
    }
  }
  return s + stars;
}

// Small sparkles near the planet
function renderSparkles(ctx, motif) {
  const { R, animate } = ctx;
  let s = "";
  motif.items.forEach((it, i) => {
    const t = it.angle * DEG;
    const x = clamp(Math.cos(t) * it.distance * R, -46, 46), y = clamp(Math.sin(t) * it.distance * R, -46, 46);
    const z = (it.size * R) / 30;
    const tw = animate ? `<animateTransform attributeName="transform" type="scale" values="1;0.45;1" dur="${f(3 + i * 1.7)}s" repeatCount="indefinite" additive="sum"/>` : "";
    s += `<g transform="translate(${f(x)} ${f(y)})"><path d="M0 ${f(-z)}Q0 0 ${f(z)} 0Q0 0 0 ${f(z)}Q0 0 ${f(-z)} 0Q0 0 0 ${f(-z)}Z" fill="${motif.color}" fill-opacity="0.9">${tw}</path></g>`;
  });
  return s;
}

// ---------------------------------------------------------------------------
// The SVG
// ---------------------------------------------------------------------------

/**
 * Draw a planet as SVG markup (a plain string: works on a server too).
 * @param {object} planet from generatePlanet
 * @param {{ size?: number, background?: boolean, animate?: boolean, idPrefix?: string, detail?: 0|1|2|3 }} [options]
 * @returns {string}
 */
export function renderPlanetSVG(planet, options = {}) {
  const p = planet;
  const size = Math.max(8, Math.round(options.size ?? 256));
  const detail = clamp(Math.round(options.detail ?? detailForSize(size)), 0, 3);
  const animate = Boolean(options.animate);
  const background = Boolean(options.background);
  const rawId = options.idPrefix ??
    `np${fnv1a32(`${p.seed}|${p.theme}|${JSON.stringify(p.overrides || {})}`).toString(36)}-${size}-${detail}${animate ? "a" : ""}${background ? "b" : ""}`;
  const id = /^[A-Za-z]/.test(rawId) ? rawId.replace(/[^\w-]/g, "_") : `p${rawId.replace(/[^\w-]/g, "_")}`;

  // Fit the planet, its glow, rings and moons inside the square
  const moons = detail === 0 ? [] : detail === 1 ? p.moons.slice(0, 2) : p.moons;
  const k = Math.sin(p.viewTilt * DEG), rot = p.rotation * DEG;
  let extent = 1 + p.glow.spread * 0.55;
  if (p.rings) {
    const a = ringRadius(p.rings.outer, detail), b = a * k;
    extent = Math.max(extent, Math.hypot(a * Math.cos(rot), b * Math.sin(rot)), Math.hypot(a * Math.sin(rot), b * Math.cos(rot)));
  }
  for (const m of moons) extent = Math.max(extent, m.distance + m.size);
  const R = clamp((50 - p.layout.padding) / extent, p.layout.minRadius, p.layout.maxRadius);

  // Light comes from the theme's direction, on the screen
  let [lx, ly] = p.shading.light;
  const ll = Math.hypot(lx, ly);
  if (ll > 0.85) { lx = (lx / ll) * 0.85; ly = (ly / ll) * 0.85; }
  const cr = Math.cos(-rot), sr = Math.sin(-rot);
  const ctx = {
    p, R, id, detail, animate, S: makeSphere(p.viewTilt), defs: [], filters: new Set(),
    light: [lx, ly], lightLocal: [lx * cr - ly * sr, lx * sr + ly * cr],
  };
  const c = p.colors, g = p.glow, sh = p.shading;

  // Surface and the layers on it
  const surf = SURFACE_RENDERERS[p.renderer](ctx);
  const clouds = renderClouds(ctx);
  const aurora = renderAurora(ctx);
  const rings = renderRings(ctx);
  const orbits = detail >= 2 ? p.motifs.find((m) => m.kind === "orbits") : null;
  const moonParts = renderMoons(ctx, moons, orbits);

  // Light and shadow
  const I = g.intensity;
  const rh = R * (1 + g.spread);
  const q = R / rh;
  ctx.defs.push(
    `<clipPath id="${id}-clip"><circle r="${f(R)}"/></clipPath>`,
    `<radialGradient id="${id}-halo" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${f(rh)}">` +
      `<stop offset="${f(q * 0.92)}" stop-color="${g.color}" stop-opacity="${f(0.85 * I)}"/>` +
      `<stop offset="${f(q + (1 - q) * 0.3)}" stop-color="${g.color}" stop-opacity="${f(0.32 * I)}"/>` +
      `<stop offset="1" stop-color="${g.color}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="${id}-term" gradientUnits="userSpaceOnUse" cx="${f(lx * R * 0.55)}" cy="${f(ly * R * 0.55)}" r="${f(R * 1.5)}">` +
      `<stop offset="0" stop-color="${c.shade}" stop-opacity="0"/><stop offset="0.38" stop-color="${c.shade}" stop-opacity="0"/>` +
      `<stop offset="0.7" stop-color="${c.shade}" stop-opacity="${f(sh.terminator * 0.62)}"/><stop offset="0.95" stop-color="${c.shade}" stop-opacity="${f(sh.terminator)}"/></radialGradient>`,
    `<radialGradient id="${id}-limb" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${f(R)}">` +
      `<stop offset="0.62" stop-color="${c.shade}" stop-opacity="0"/><stop offset="0.9" stop-color="${c.shade}" stop-opacity="${f(sh.limb * 0.45)}"/>` +
      `<stop offset="1" stop-color="${c.shade}" stop-opacity="${f(sh.limb)}"/></radialGradient>`,
    `<radialGradient id="${id}-atmo" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${f(R)}">` +
      `<stop offset="0.8" stop-color="${g.color}" stop-opacity="0"/><stop offset="0.95" stop-color="${g.color}" stop-opacity="${f(g.rim * I * 0.32)}"/>` +
      `<stop offset="1" stop-color="${g.color}" stop-opacity="${f(g.rim * I * 0.75)}"/></radialGradient>`,
    `<radialGradient id="${id}-spec"><stop offset="0" stop-color="${c.specular}" stop-opacity="${f(sh.specular)}"/><stop offset="1" stop-color="${c.specular}" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="${id}-rimlit" gradientUnits="userSpaceOnUse" x1="${f(lx * R)}" y1="${f(ly * R)}" x2="${f(-lx * R * 0.3)}" y2="${f(-ly * R * 0.3)}">` +
      `<stop offset="0" stop-color="${mix(g.color, c.specular, 0.55)}" stop-opacity="${f(0.95 * g.rim)}"/><stop offset="1" stop-color="${g.color}" stop-opacity="0"/></linearGradient>`
  );
  const pulse = animate ? `<animate attributeName="opacity" values="0.82;1;0.82" dur="6s" repeatCount="indefinite"/>` : "";
  const halo =
    `<g>${pulse}<circle r="${f(rh)}" fill="url(#${id}-halo)"/>` +
    (detail >= 1 ? `<circle r="${f(R * 1.005)}" fill="none" stroke="${g.color}" stroke-opacity="${f(0.55 * I)}" stroke-width="${f(R * 0.07)}" ${blurFilter(ctx, "glow", soft(ctx, "glow"))}/>` : "") +
    `</g>`;
  const spinT = `rotate(${f(p.rotation)})`;
  const sx = lx * R * 0.42, sy = ly * R * 0.42, sang = f((Math.atan2(ly, lx) * 180) / Math.PI);
  const sphere =
    `<g clip-path="url(#${id}-clip)">` +
    `<g transform="${spinT}">${surf.under}${clouds}${rings.shadow}</g>` +
    `<circle r="${f(R)}" fill="url(#${id}-limb)"/><circle r="${f(R)}" fill="url(#${id}-term)"/>` +
    (surf.emit || aurora ? `<g transform="${spinT}">${surf.emit}${aurora}</g>` : "") +
    `<circle r="${f(R)}" fill="url(#${id}-atmo)"/>` +
    `<ellipse cx="${f(sx)}" cy="${f(sy)}" rx="${f(R * 0.32)}" ry="${f(R * 0.23)}" transform="rotate(${sang} ${f(sx)} ${f(sy)})" fill="url(#${id}-spec)"/>` +
    (sh.gloss > 0 && detail >= 1 ? `<circle cx="${f(lx * R * 0.5)}" cy="${f(ly * R * 0.5)}" r="${f(R * 0.11)}" fill="url(#${id}-spec)" opacity="${f(sh.gloss)}"/>` : "") +
    `<circle r="${f(R * 0.985)}" fill="none" stroke="url(#${id}-rimlit)" stroke-width="${f(R * 0.045)}"${detail >= 1 ? " " + blurFilter(ctx, "surface", soft(ctx, "surface")) : ""}/>` +
    `</g>`;

  let sparkles = "";
  if (detail >= 2) for (const m of p.motifs) if (m.kind === "sparkle") sparkles += renderSparkles(ctx, m);
  const bgMarkup = background ? renderBackground(ctx, size) : "";

  const label = p.description || p.name || "Planet";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">` +
    `<title>${esc(p.name ? `${p.name}: ${label}` : label)}</title>` +
    `<defs>${ctx.defs.join("")}</defs>` +
    bgMarkup + halo + rings.back + moonParts.back + sphere + rings.front + moonParts.front + sparkles +
    `</svg>`
  );
}

/**
 * Turn SVG markup into a data URI for an <img src> or CSS background.
 * @param {string} svg
 * @returns {string}
 */
export function planetToDataURI(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
