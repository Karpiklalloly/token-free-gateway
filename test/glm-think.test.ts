import { describe, expect, test } from "bun:test";
import { resolveGlmThink } from "../src/providers/glm-intl/client.ts";

describe("resolveGlmThink", () => {
	test("suffix wins over effort", () => {
		expect(resolveGlmThink(true, "none")).toBe(true);
		expect(resolveGlmThink(false, "high")).toBe(false);
	});
	test("effort applies without suffix", () => {
		expect(resolveGlmThink(undefined, "high")).toBe(true);
		expect(resolveGlmThink(undefined, "none")).toBe(false);
	});
	test("undefined without suffix or effort leaves UI as-is", () => {
		expect(resolveGlmThink(undefined, undefined)).toBeUndefined();
	});
});
