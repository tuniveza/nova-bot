// The Nova placeholder theme: all the art direction for Nova suite planets.
// The generator never picks a colour or a style by itself; it reads them from
// here. The studio's lore will be a new file shaped like this one.
//
// Colours are small references (see the README for the full list):
//   "a0".."a4" / "b0".."b4"  the palette's two ramps, dark to light
//   "accent", "glow"         the palette's accent, the planet's glow colour
//   "gold.3"                 any named ramp below
//   "@frost"                 a fixed colour from `colors` (never hue-shifted)
//   "a3+@white:0.4"          a mix of two (0 = all left, 1 = all right)

/** @type {import("../generator.js").Theme} */
const nova = {
  id: "nova",
  name: "Nova",

  // Fixed colours, never turned by the hue shift
  colors: {
    white: "#FFFFFF",
    shade: "#06040D",
    space: "#1A1236",
    frost: "#F3EEFF",
    cloud: "#FFF3FA",
    dust: "#B9A8CC",
    crust: "#150A12",
    hot: "#FFF1CF",
  },

  // Colour ramps, each from deep shadow to bright highlight
  ramps: {
    magenta: ["#3D0A26", "#7A1546", "#B01D68", "#FF5FA8", "#FFC4DF"],
    purple: ["#1E1240", "#4A1C6E", "#7A1F86", "#A874D9", "#C7A4FF"],
    deep: ["#0A0718", "#1C1440", "#2F2266", "#4A3A94", "#7466C4"],
    gold: ["#3A2712", "#7A5A2C", "#C9A25E", "#F2D9A0", "#FFF2D4"],
    cyan: ["#05202E", "#0B4A66", "#178FB8", "#5AD8F5", "#C4F5FF"],
    teal: ["#04221F", "#0B4F48", "#16897C", "#45CBB4", "#B3F3E6"],
    ember: ["#260805", "#661A0B", "#C2410C", "#FF7A3D", "#FFC79A"],
  },

  // Palettes pair two ramps with an accent and glow colours. `label` names it in captions.
  palettes: [
    { id: "magenta-gold", label: "magenta & gold", weight: 3, a: "magenta", b: "gold", accent: "gold.3", glow: ["magenta.3", "gold.3"] },
    { id: "magenta-violet", label: "magenta & violet", weight: 3, a: "magenta", b: "purple", accent: "purple.4", glow: ["magenta.3", "purple.4"] },
    { id: "violet-cyan", label: "violet & cyan", weight: 2, a: "purple", b: "cyan", accent: "cyan.3", glow: ["purple.4", "cyan.3"] },
    { id: "violet-gold", label: "violet & gold", weight: 2, a: "purple", b: "gold", accent: "gold.3", glow: ["purple.4", "gold.3"] },
    { id: "indigo-gold", label: "indigo & gold", weight: 2, a: "deep", b: "purple", accent: "gold.3", glow: ["purple.4", "gold.3"] },
    { id: "cyan-teal", label: "cyan & teal", weight: 2, a: "cyan", b: "teal", accent: "gold.3", glow: ["cyan.3", "teal.3"] },
    { id: "teal-magenta", label: "teal & magenta", weight: 1, a: "teal", b: "magenta", accent: "magenta.3", glow: ["teal.3", "magenta.3"] },
    { id: "ember-gold", label: "ember & gold", weight: 2, a: "ember", b: "gold", accent: "gold.3", glow: ["ember.3", "gold.3"] },
    { id: "ember-magenta", label: "ember & magenta", weight: 1, a: "ember", b: "magenta", accent: "magenta.3", glow: ["ember.3", "magenta.3"] },
  ],

  // The kinds of planet, how often each comes up, and how each is drawn.
  // renderer: bands | craters | continents | cracks | frost (or a list to choose from)
  // rings / storm / aurora: the chance of each; clouds: [min, max] cover
  surfaces: [
    {
      id: "gas", weight: 3, renderer: "bands", rings: 0.2, storm: 0.55, aurora: 0.3, clouds: [0, 0],
      colors: {
        base: "a1", zones: ["a3", "b3", "a3+b3:0.5", "b4+a3:0.35"], belts: ["a1", "a2", "b1+a2:0.5", "a2+b2:0.3"],
        storm: "accent+a2:0.3", stormEye: "accent+@white:0.2",
      },
      look: { bands: [9, 15], wave: [0.8, 3.2], blend: 0.35, streaks: 10, turbulence: 2.2, drift: [50, 110] },
    },
    {
      id: "rock", weight: 2, renderer: "craters", rings: 0.08, storm: 0, aurora: 0.1, clouds: [0, 0.25],
      colors: { base: "a1+@dust:0.28", light: "a2+@dust:0.42", dark: "a0+b0:0.4", crater: "a0+@shade:0.15", rim: "a3+@dust:0.5" },
      look: { patches: 7, patchSize: [14, 34], craters: 22, craterSize: [2.2, 14] },
    },
    {
      id: "ocean", weight: 3, renderer: "continents", rings: 0.08, storm: 0.45, aurora: 0.35, clouds: [0.3, 0.75], gloss: 0.6,
      palettes: ["cyan-teal", "violet-cyan", "magenta-violet", "teal-magenta"],
      colors: { sea: "a1+a2:0.45", seaDeep: "a0+a1:0.5", shallows: "a3", land: "b2", landHigh: "b3+accent:0.35", ice: "@frost" },
      look: { continents: [3, 5], size: [20, 36], islands: 8, islandSize: [3, 7], deeps: 3, roughness: 0.55, iceCaps: 0.7, capLatitude: [64, 76] },
    },
    {
      id: "molten", weight: 2, renderer: "cracks", rings: 0.06, storm: 0, aurora: 0, clouds: [0, 0],
      palettes: ["ember-gold", "ember-magenta", "magenta-gold"],
      colors: { base: "a0+a1:0.25", plate: "@crust", crack: "a3", core: "@hot+a4:0.35", lava: "a3+accent:0.3" },
      look: { plates: 9, pools: 6, poolSize: [4, 10], cracks: 22, step: 4.5, crackWidth: [0.3, 0.75] },
    },
    {
      id: "ice", weight: 2, renderer: "frost", rings: 0.15, storm: 0, aurora: 0.25, clouds: [0, 0.2], gloss: 0.35,
      palettes: ["violet-cyan", "cyan-teal", "indigo-gold", "magenta-violet", "violet-gold"],
      colors: { base: "b3+@frost:0.4", light: "@frost", streak: "a2+b3:0.3", crack: "b2+a1:0.4" },
      look: { streaks: 9, lineae: 9, cracks: 10, step: 5, iceCaps: 0.6, capLatitude: [60, 74] },
    },
    {
      id: "ringed", weight: 2, renderer: ["bands", "frost"], rings: 1, storm: 0.35, aurora: 0.15, clouds: [0, 0],
      colors: {
        base: "a1", zones: ["a3", "b3", "a4+b3:0.5"], belts: ["a2", "b2", "a2+b1:0.5"],
        storm: "accent+a2:0.3", stormEye: "accent+@white:0.2",
      },
      look: { bands: [7, 12], wave: [0.5, 2], blend: 0.45, streaks: 6, turbulence: 1.4, drift: [60, 120] },
      // As an ice giant it is pale and streaky
      variants: {
        frost: {
          colors: { base: "b3+@frost:0.4", light: "@frost", streak: "a2", crack: "b2" },
          look: { streaks: 12, lineae: 3, cracks: 0, step: 5, iceCaps: 0.4, capLatitude: [62, 72] },
        },
      },
    },
  ],

  // Light, shadow and pose. light is the screen direction the light comes from.
  shading: {
    light: [-0.55, -0.62],
    terminator: 0.9,
    limb: 0.55,
    specular: 0.26,
    shade: "@shade",
    specularColor: "@white",
    viewTilt: [14, 26],
    rotation: [-24, 24],
    hueShift: [-9, 9],
  },

  // The glow round each planet: strength, how far it reaches (in radii), rim light
  glow: { intensity: [0.5, 1], spread: [0.22, 0.42], rim: 0.9 },

  // Softness, in SVG units for a planet of radius 30
  blur: { surface: 0.22, clouds: 0.75, glow: 2.2 },

  // How the planet sits in its square
  layout: { padding: 2.5, minRadius: 21, maxRadius: 35 },

  clouds: { color: "@cloud", opacity: [0.35, 0.8], count: 20, thickness: [1, 4.2], length: [35, 130] },

  rings: {
    inner: [1.3, 1.48],
    width: [0.38, 0.72],
    shadow: 0.38,
    styles: [
      { id: "dust", weight: 2, colors: ["a3", "b3", "a4+b4:0.5", "accent"], opacity: [0.35, 0.8], bands: [4, 8], gaps: 0.22 },
      { id: "ice", weight: 2, colors: ["@frost", "b4", "accent+@white:0.4"], opacity: [0.35, 0.85], bands: [3, 7], gaps: 0.25 },
      { id: "glow", weight: 1, colors: ["glow", "accent", "a4"], opacity: [0.4, 0.85], bands: [2, 5], gaps: 0.3 },
    ],
  },

  // Chance of 0, 1, 2 or 3 moons; orbit sizes in planet radii
  moons: {
    weights: [4, 4, 3, 2],
    distance: [1.5, 1.95],
    size: [0.07, 0.14],
    colors: ["@dust", "b2+@dust:0.5", "a2+@dust:0.45", "accent+@dust:0.35"],
    period: [24, 60],
    inclination: [-12, 12],
  },

  aurora: { colors: ["glow", "accent+@white:0.3", "b3"], latitude: 67, width: 2.6, opacity: 0.85 },

  storm: { latitude: [-32, 30], longitude: [-45, 45], size: [6, 12] },

  // Decorations around the planet (only on bigger sizes)
  motifs: [
    { kind: "sparkle", chance: 0.55, color: "accent+@white:0.55", count: [1, 3], size: [1.6, 3.2], distance: [1.3, 1.85] },
    { kind: "orbits", chance: 0.75, color: "glow", opacity: 0.22 },
  ],

  // The starfield for background: true. starCount is per detail level (badge to hero)
  background: {
    colors: ["@space", "@shade"],
    nebula: ["a2", "b2", "glow"],
    nebulaOpacity: 0.3,
    stars: ["@white", "gold.4", "purple.4", "cyan.4"],
    starCount: [0, 12, 30, 80],
  },

  // Words: what each kind of planet is called, and a proper name for each planet
  naming: {
    join: " · ",
    type(planet) {
      if (planet.surface === "ringed") return planet.renderer === "frost" ? "Ringed ice giant" : "Ringed gas giant";
      const names = { gas: "Gas giant", rock: "Rocky world", ocean: "Ocean world", molten: "Molten world", ice: "Ice world" };
      const base = names[planet.surface] || "Planet";
      return planet.rings ? `Ringed ${base.toLowerCase()}` : base;
    },
    palette(planet, palette) {
      return palette ? palette.label : "";
    },
    moons(count) {
      return count === 0 ? "" : count === 1 ? "1 moon" : `${count} moons`;
    },
    // rand is the planet's own seeded stream, so names are stable too
    name(planet, rand) {
      const pick = (list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
      const starts = ["Ae", "Cy", "Ly", "Ny", "Or", "Ve", "Xa", "Zo", "Ka", "Se", "Mi", "Ra", "Tha", "Io", "Eu", "Vy", "Sol", "Nov"];
      const middles = ["ra", "li", "ve", "no", "sa", "ri", "the", "lo", "mi", "xa", "dra", "ny"];
      const ends = ["n", "s", "ra", "x", "ris", "on", "ae", "is", "ne", "va", "th", "ia"];
      const suffixes = ["", "", "", " Prime", " II", " III", " IV", " VII", " Major", " Minor"];
      const middle = rand() < 0.6 ? pick(middles) : "";
      return pick(starts) + middle + pick(ends) + pick(suffixes);
    },
  },
};

export default nova;
