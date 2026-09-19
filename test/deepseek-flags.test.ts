import { describe, expect, test } from "bun:test";
import {
	DeepSeekWebClient,
	resolveDeepSeekFlags,
} from "../src/providers/deepseek/client.ts";
import { BrowserManager } from "../src/browser/manager.ts";

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

	test("legacy searchEnabled applies when no suffix", () => {
		expect(resolveDeepSeekFlags("deepseek-chat", undefined, false).search).toBe(false);
		expect(resolveDeepSeekFlags("deepseek-chat:search-off", undefined, true).search).toBe(false);
	});
});

test("DeepSeekWebClient creates a dedicated page instead of using a user tab", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	let newPageCalls = 0;
	let userPageTouched = false;
	const dedicatedPage = { evaluate: async () => "complete", goto: async () => undefined };
	const originalGetInstance = BrowserManager.getInstance;
	(BrowserManager as unknown as { getInstance: typeof BrowserManager.getInstance }).getInstance = () =>
		({
			getContext: async () => ({
				newPage: async () => {
					newPageCalls++;
					return dedicatedPage;
				},
			}),
			getPage: async () => {
				userPageTouched = true;
				return {};
			},
		}) as any;

	try {
		await client.init();
		await client.init();
	} finally {
		(BrowserManager as unknown as { getInstance: typeof BrowserManager.getInstance }).getInstance =
			originalGetInstance;
	}

	expect(newPageCalls).toBe(1);
	expect(userPageTouched).toBe(false);
});
