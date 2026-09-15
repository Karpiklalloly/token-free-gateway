import { describe, expect, test } from "bun:test";
import { effortToThink, parseModelString } from "../src/providers/model-spec.ts";

describe("parseModelString", () => {
	test("base id without suffix passes through", () => {
		expect(parseModelString("deepseek-reasoner")).toEqual({
			base: "deepseek-reasoner",
			think: undefined,
			search: undefined,
		});
	});

	test("parses think and search-off suffixes", () => {
		expect(parseModelString("deepseek-reasoner:no-think:search-off")).toEqual({
			base: "deepseek-reasoner",
			think: false,
			search: false,
		});
	});

	test("later suffix wins on conflict", () => {
		expect(parseModelString("deepseek-chat:no-think:think")).toEqual({
			base: "deepseek-chat",
			think: true,
			search: undefined,
		});
	});

	test("unknown suffix throws 400 ProviderApiError", () => {
		try {
			parseModelString("deepseek-chat:turbo");
			throw new Error("should have thrown");
		} catch (err: any) {
			expect(err.name).toBe("ProviderApiError");
			expect(err.httpStatus).toBe(400);
			expect(String(err.message)).toContain("turbo");
		}
	});

	test("strips provider prefix before parsing", () => {
		expect(parseModelString("glm-intl-web/glm-5.3")).toEqual({
			base: "glm-5.3",
			think: undefined,
			search: undefined,
		});
		expect(parseModelString("deepseek-web/deepseek-chat:think")).toEqual({
			base: "deepseek-chat",
			think: true,
			search: undefined,
		});
	});
});

describe("effortToThink", () => {
	test("maps efforts to binary thinking", () => {
		expect(effortToThink(undefined)).toBeUndefined();
		expect(effortToThink("none")).toBe(false);
		expect(effortToThink("minimal")).toBe(false);
		expect(effortToThink("low")).toBe(true);
		expect(effortToThink("medium")).toBe(true);
		expect(effortToThink("high")).toBe(true);
		expect(effortToThink("xhigh")).toBe(true);
	});
});
