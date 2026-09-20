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

test("DeepSeekWebClient keeps dedicated pages separate by conversation", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	let newPageCalls = 0;
	let userPageTouched = false;
	const pages: unknown[] = [];
	const originalGetInstance = BrowserManager.getInstance;
	(BrowserManager as unknown as { getInstance: typeof BrowserManager.getInstance }).getInstance = () =>
		({
			addCookies: async () => undefined,
			getContext: async () => ({
				newPage: async () => {
					newPageCalls++;
					const page = { evaluate: async () => "complete", goto: async () => undefined };
					pages.push(page);
					return page;
				},
			}),
			getPage: async () => {
				userPageTouched = true;
				return {};
			},
		}) as any;

	try {
		const internals = client as unknown as {
			getPageForConversation: (conversationId: string) => Promise<unknown>;
		};
		const first = await internals.getPageForConversation("ses_chat_a");
		const repeated = await internals.getPageForConversation("ses_chat_a");
		const second = await internals.getPageForConversation("ses_chat_b");
		expect(first).toBe(repeated);
		expect(first).not.toBe(second);
	} finally {
		(BrowserManager as unknown as { getInstance: typeof BrowserManager.getInstance }).getInstance =
			originalGetInstance;
	}

	expect(newPageCalls).toBe(2);
	expect(pages).toHaveLength(2);
	expect(userPageTouched).toBe(false);
});

test("DeepSeekWebClient rejects requests without a chat ID", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	await expect(client.sendMessage({ message: "task" })).rejects.toMatchObject({
		httpStatus: 400,
		message: "DeepSeek routing requires a chat identifier",
	});
});

test("DeepSeekWebClient sends after paste attachments are processed", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const state = {
		pasted: "",
		messageCount: 5,
		lastMessageText: "previous answer",
		continueClicks: 0,
		continueVisible: true,
		inputReady: false,
		pasteProcessed: false,
		uploaded: undefined as unknown,
		sendButtonReady: false,
		sendButtonChecks: 0,
		sendAttempts: 0,
		enterPresses: 0,
	};
	const input = {
		count: async () => 1,
		first() {
			return this;
		},
		elementHandle: async () => input,
		click: async () => undefined,
		innerText: async () => "",
		inputValue: async () => state.pasted,
		evaluate: async () => state.pasted,
		isEditable: async () => {
			const ready = state.inputReady;
			state.inputReady = true;
			return ready;
		},
		fill: async () => {
			throw new Error("DeepSeek should use human-like paste instead of fill");
		},
		press: async (key: string) => {
			if (key !== "Enter") throw new Error(`unexpected key: ${key}`);
			state.enterPresses++;
			state.lastMessageText = "completed answer";
		},
	};
	const fileInput = {
		count: async () => 1,
		first() {
			return this;
		},
		setInputFiles: async (files: unknown) => {
			state.uploaded = files;
		},
	};
	const assistant = {
		locator: () => ({
			last: () => ({ innerText: async () => state.lastMessageText }),
		}),
		innerText: async () => state.lastMessageText,
	};
	const sendButton = {
		count: async () => 1,
		last() {
			return this;
		},
		isEnabled: async () => {
			return true;
		},
		evaluate: async () => {
			state.sendButtonChecks++;
			if (state.sendButtonChecks >= 2) state.sendButtonReady = true;
			return state.sendButtonReady;
		},
		click: async () => {
			if (!state.sendButtonReady) throw new Error("send button clicked before it became active");
			state.sendAttempts++;
			state.lastMessageText = "completed answer";
		},
	};
	const page = {
		locator: (selector: string) => {
			if (selector.includes('input[type="file"]')) return fileInput;
			if (selector.includes("textarea")) return input;
			if (selector.includes("button")) return sendButton;
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
		evaluate: async () => "",
		waitForFunction: async () => {
			throw new Error("submission detection must not trigger a duplicate send");
		},
		waitForTimeout: async () => undefined,
		keyboard: {
			press: async (key: string) => {
				if (key.includes("KeyV")) {
					state.pasteProcessed = true;
					return;
				}
				if (key === "Enter" && !state.sendButtonReady) {
					throw new Error("DeepSeek sent before the paste was processed");
				}
				state.lastMessageText = "completed answer";
			},
		},
		url: () => "https://chat.deepseek.com/",
	};
	const internals = client as unknown as {
		getPageForConversation: () => Promise<unknown>;
	};
	internals.getPageForConversation = async () => page;

	const result = await client.parseStream(
		await client.sendMessage({
			message: "task",
			conversationId: "ses_chat_a",
			images: [{ url: "data:image/png;base64,AA==" }],
		}),
	);

	expect(result.text).toBe("completed answer");
	expect(state.continueClicks).toBe(1);
	expect(state.pasteProcessed).toBe(true);
	expect(state.uploaded).toEqual([
		{ name: "image-0.png", mimeType: "image/png", buffer: expect.anything() },
	]);
	expect(state.enterPresses).toBe(1);
	expect(state.sendAttempts).toBe(0);
});

test("DeepSeekWebClient serializes requests to its dedicated page", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const submitted: string[] = [];
	let releaseFirst: (value: string) => void = () => {};
	const internals = client as unknown as {
		getPageForConversation: () => Promise<unknown>;
		sendViaDom: (_page: unknown, params: { message: string }) => Promise<string>;
	};
	internals.getPageForConversation = async () => ({ url: () => "https://chat.deepseek.com/" });
	internals.sendViaDom = async (_page, params) => {
		submitted.push(params.message);
		if (params.message === "first") return new Promise<string>((resolve) => (releaseFirst = resolve));
		return "second answer";
	};

	const first = client.sendMessage({ message: "first", conversationId: "ses_chat_a" });
	await Promise.resolve();
	const second = client.sendMessage({ message: "second", conversationId: "ses_chat_a" });
	await Promise.resolve();

	expect(submitted).toEqual(["first"]);
	releaseFirst("first answer");
	await first;
	await second;
	expect(submitted).toEqual(["first", "second"]);
});

test("DeepSeekWebClient does not queue different conversations together", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const submitted: string[] = [];
	let releaseFirst: (value: string) => void = () => {};
	const internals = client as unknown as {
		getPageForConversation: () => Promise<unknown>;
		sendViaDom: (_page: unknown, params: { message: string }) => Promise<string>;
	};
	internals.getPageForConversation = async () => ({ url: () => "https://chat.deepseek.com/" });
	internals.sendViaDom = async (_page, params) => {
		submitted.push(params.message);
		if (params.message === "first") return new Promise<string>((resolve) => (releaseFirst = resolve));
		return "second answer";
	};

	const first = client.sendMessage({ message: "first", conversationId: "ses_chat_a" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	const second = client.sendMessage({ message: "second", conversationId: "ses_chat_b" });
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(submitted).toEqual(["first", "second"]);
	releaseFirst("first answer");
	await first;
	await second;
});
