import { describe, expect, test } from "bun:test";
import { resolveDeepSeekFlags } from "../src/providers/deepseek/client.ts";

describe("resolveDeepSeekFlags", () => {
	test("defaults: chat=not thinking+search, reasoner=thinking+search", () => {
		expect(resolveDeepSeekFlags("deepseek-chat", undefined)).toEqual({
			base: "deepseek-chat",
			thinking: false,
			search: true,
		});
		expect(resolveDeepSeekFlags("deepseek-reasoner", undefined)).toEqual({
			base: "deepseek-reasoner",
			thinking: true,
			search: true,
		});
	});

	test("suffixes override defaults", () => {
		expect(resolveDeepSeekFlags("deepseek-chat:think", undefined).thinking).toBe(true);
		expect(resolveDeepSeekFlags("deepseek-reasoner:no-think", undefined).thinking).toBe(false);
		expect(resolveDeepSeekFlags("deepseek-chat:search-off", undefined).search).toBe(false);
	});

	test("reasoning_effort applies when no suffix, suffix wins on conflict", () => {
		expect(resolveDeepSeekFlags("deepseek-chat", "high").thinking).toBe(true);
		expect(resolveDeepSeekFlags("deepseek-reasoner", "none").thinking).toBe(false);
		expect(resolveDeepSeekFlags("deepseek-chat:think", "none").thinking).toBe(true);
	});

	test("combined suffixes resolve together", () => {
		expect(resolveDeepSeekFlags("deepseek-chat:think:search-off", undefined)).toEqual({
			base: "deepseek-chat",
			thinking: true,
			search: false,
		});
	});
});
