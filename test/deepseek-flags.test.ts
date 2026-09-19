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

test("DeepSeekWebClient clicks Continue and returns the settled DOM answer", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const state = { typed: "", messageCount: 0, continueClicks: 0, continueVisible: true };
	const input = {
		count: async () => 1,
		first() {
			return this;
		},
		click: async () => undefined,
		elementHandle: async () => ({ innerText: async () => state.typed }),
	};
	const assistant = {
		locator: () => ({
			last: () => ({ innerText: async () => "completed answer" }),
		}),
		innerText: async () => "completed answer",
	};
	const page = {
		locator: (selector: string) => {
			if (selector.includes("textarea")) return input;
			return {
				count: async () => state.messageCount,
				last: () => assistant,
			};
		},
		getByRole: () => ({
			last: () => ({
				isVisible: async () => state.continueVisible,
				click: async () => {
					state.continueClicks++;
					state.continueVisible = false;
				},
			}),
		}),
		evaluate: async (_fn: unknown, value?: unknown) => {
			if (typeof value === "string") state.typed = value;
			return "";
		},
		waitForFunction: async () => undefined,
		waitForTimeout: async () => undefined,
		keyboard: {
			press: async () => {
				state.messageCount = 2;
			},
		},
	};
	const internals = client as unknown as { getPage: () => Promise<unknown> };
	internals.getPage = async () => page;

	const result = await client.parseStream(await client.sendMessage({ message: "task" }));

	expect(result.text).toBe("completed answer");
	expect(state.continueClicks).toBe(1);
	expect(state.typed).toBe("task");
});

test("DeepSeekWebClient serializes requests to its dedicated page", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const submitted: string[] = [];
	let releaseFirst: (value: string) => void = () => {};
	const internals = client as unknown as {
		getPage: () => Promise<unknown>;
		sendViaDom: (_page: unknown, params: { message: string }) => Promise<string>;
	};
	internals.getPage = async () => ({});
	internals.sendViaDom = async (_page, params) => {
		submitted.push(params.message);
		if (params.message === "first") return new Promise<string>((resolve) => (releaseFirst = resolve));
		return "second answer";
	};

	const first = client.sendMessage({ message: "first" });
	await Promise.resolve();
	const second = client.sendMessage({ message: "second" });
	await Promise.resolve();

	expect(submitted).toEqual(["first"]);
	releaseFirst("first answer");
	await first;
	await second;
	expect(submitted).toEqual(["first", "second"]);
});
