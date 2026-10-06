// The master list of links: only the expected shape is kept
import { describe, expect, it } from "vitest";
import { cleanLinks } from "../src/links.js";

describe("the links list", () => {
	it("keeps names, web addresses and kinds, and drops anything else", () => {
		const clean = cleanLinks({
			groups: [
				{
					title: "Live",
					items: [
						{ name: "Nova Hub", url: "https://example.workers.dev/app/", kind: "live" },
						{ name: "Sandbox", url: "http://localhost:8787", kind: "testing" },
						{ name: "Tests", url: "npx vitest run", kind: "testing" },
						{ name: "Sneaky", url: "javascript:alert(1)", kind: "live" },
						{ name: "Odd kind", url: "https://x.dev", kind: "whatever" },
					],
				},
			],
		});
		expect(clean.groups[0].items.map((i) => i.name)).toEqual(["Nova Hub", "Sandbox", "Tests", "Odd kind"]);
		expect(clean.groups[0].items.at(-1).kind).toBe("live");
	});

	it("keeps the features, app by app", () => {
		const clean = cleanLinks({ groups: [], features: [{ app: "Nova Agent", items: [{ name: "Pulses", detail: "Every second" }, { detail: "no name" }] }, { items: [{ name: "x" }] }] });
		expect(clean.features[0]).toEqual({ app: "Nova Agent", note: "", items: [{ name: "Pulses", detail: "Every second" }] });
		expect(clean.features[1].app).toBe("Nova suite");
	});

	it("keeps the changelog newest first, with a size for every change", () => {
		const clean = cleanLinks({ changelog: [
			{ date: "2026-10-05", app: "Nova Hub", size: "big", title: "Themes", what: "a", why: "b", benefit: "c" },
			{ date: "2026-10-06", app: "Nova Agent", size: "huge", title: "Pulses", what: "a", why: "b", benefit: "c" },
			{ date: "yesterday", title: "No date" },
		] });
		expect(clean.changelog.map((c) => [c.date, c.size])).toEqual([["2026-10-06", "small"], ["2026-10-05", "big"]]);
	});
});
