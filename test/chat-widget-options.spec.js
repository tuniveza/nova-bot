// The website chat's options (16 Oct 2026): the sound's seed changes every hour unless kept, each
// seed is a mood, the volume is kept, and the theme turns the chat's colours and can tint the
// website, never over its videos. (Checked in a browser too; here: what's shipped says so.)
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

let js = "";
let css = "";
beforeAll(async () => {
  js = await (await env.ASSETS.fetch("https://novacane-worker.test/novabot.js")).text();
  css = await (await env.ASSETS.fetch("https://novacane-worker.test/novabot.css")).text();
});

describe("the sound's seed", () => {
  it("changes on the hour, unless a seed is kept", () => {
    expect(js).toContain("const hourSeed = () => Math.floor(Date.now() / 3600000);");
    expect(js).toContain("let seed = keptSeed() ?? hourSeed();");
    expect(js).toContain("if (keptSeed() === null && hourSeed() !== seed) useSeed(hourSeed());");
  });
  it("every choice the music makes comes from the seed (not Math.random)", () => {
    const music = js.slice(js.indexOf("const TYPING_KITS = ["), js.indexOf("function startMusic()"));
    expect(music).toContain("rnd()");
    expect(music.replace(/data\[i\] = [^;]*Math\.random[^;]*;/g, "")).not.toContain("Math.random()");
  });
  it("each seed is a mood: its key, warmth, shimmer, room and pad", () => {
    expect(js).toMatch(/const MOODS = \[\n(\s+\{ name: "[^"]+", transpose: [^}]+\},\n){8}/);
    expect(js).toContain("freq *= MOOD.transpose;");
  });
});

describe("the options (the cogwheel, bottom left)", () => {
  it("has the sound, its volume, the theme and the website's tint", () => {
    for (const id of ['id="nv-options-open"', 'id="nv-keep-sound"', 'id="nv-new-sound"', 'id="nv-volume"', 'class="nv-opt-row nv-themes"', 'data-tint="0"', 'data-tint="2"']) expect(js).toContain(id);
    expect(css).toContain(".nv-gear {");
  });
  it("the tint covers the page but cuts a hole for every video", () => {
    expect(js).toContain('for (const v of document.querySelectorAll("video, iframe")) {');
    expect(js).toContain('tintPath.setAttribute("fill-rule", "evenodd");');
    expect(css).toMatch(/\.nv-tint \{[^}]*pointer-events: none;[^}]*mix-blend-mode: color;/);
  });
  it("the theme turns the whole chat's colours (and only costs a filter when one is chosen)", () => {
    expect(css).toContain('#nv-chat:not([data-theme="novacane"]) #nv-chat-panel { filter: var(--nv-theme-filter, none); }');
  });
});
