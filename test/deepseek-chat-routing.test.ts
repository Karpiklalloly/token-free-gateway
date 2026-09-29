import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "../src/browser/manager.ts";
import type { ChatMessage } from "../src/openai/types.ts";
import { getDeepSeekChatRoute, setDeepSeekChatRoute } from "../src/providers/deepseek/chat-routes.ts";
import { DeepSeekWebClient, selectDeepSeekMessages } from "../src/providers/deepseek/client.ts";

let storeDir = "";
let originalStorePath: string | undefined;

afterEach(() => {
	if (originalStorePath === undefined) delete process.env.TFG_STORE_PATH;
	else process.env.TFG_STORE_PATH = originalStorePath;
	if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

test("DeepSeek restores a saved chat URL in a new service page", async () => {
	storeDir = mkdtempSync(join(tmpdir(), "tfg-deepseek-routing-"));
	originalStorePath = process.env.TFG_STORE_PATH;
	process.env.TFG_STORE_PATH = join(storeDir, "auth-profiles.json");
	setDeepSeekChatRoute("ses_chat_a", "https://chat.deepseek.com/a/chat/s/chat-a");

	const gotos: string[] = [];
	const originalGetInstance = BrowserManager.getInstance;
	(BrowserManager as unknown as { getInstance: typeof BrowserManager.getInstance }).getInstance = () =>
		({
			addCookies: async () => undefined,
			getContext: async () => ({
				newPage: async () => ({
					evaluate: async () => "complete",
					goto: async (url: string) => {
						gotos.push(url);
					},
				}),
			}),
		}) as any;

	try {
		const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
		const internals = client as unknown as {
			getPageForConversation: (conversationId: string) => Promise<unknown>;
		};
		await internals.getPageForConversation("ses_chat_a");
	} finally {
		(BrowserManager as unknown as { getInstance: typeof BrowserManager.getInstance }).getInstance =
			originalGetInstance;
	}

	expect(gotos).toEqual(["https://chat.deepseek.com/a/chat/s/chat-a"]);
});

test("DeepSeek sends only new user and tool messages after a completed turn", () => {
	const messages: ChatMessage[] = [
		{ role: "system", content: "You are helpful" },
		{ role: "user", content: "Build a game" },
		{ role: "assistant", content: "I will inspect the files" },
		{ role: "user", content: "Continue" },
	];
	expect(selectDeepSeekMessages(messages, true)).toEqual([{ role: "user", content: "Continue" }]);
	const toolMessages: ChatMessage[] = [
		...messages,
		{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "call_1", content: "file.txt" },
	];
	expect(selectDeepSeekMessages(toolMessages, true)).toEqual([{ role: "tool", tool_call_id: "call_1", content: "file.txt" }]);
});

test("DeepSeek opens a fresh chat and retries once after a length-limit reply", async () => {
	storeDir = mkdtempSync(join(tmpdir(), "tfg-deepseek-rollover-"));
	originalStorePath = process.env.TFG_STORE_PATH;
	process.env.TFG_STORE_PATH = join(storeDir, "auth-profiles.json");
	setDeepSeekChatRoute("ses_full", "https://chat.deepseek.com/a/chat/s/old-chat");
	let url = "https://chat.deepseek.com/a/chat/s/old-chat";
	const visits: string[] = [];
	const prompts: string[] = [];
	const page = {
		goto: async (target: string) => {
			visits.push(target);
			url = "https://chat.deepseek.com/a/chat/s/new-chat";
		},
		url: () => url,
	};
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const internals = client as unknown as {
		getPageForConversation: () => Promise<unknown>;
		sendViaDom: (_page: unknown, params: { message: string }) => Promise<string>;
	};
	internals.getPageForConversation = async () => page;
	internals.sendViaDom = async (_page, params) => {
		prompts.push(params.message);
		return prompts.length === 1 ? "Length limit reached. Please start a new chat." : "done";
	};
	const history = {
		model: "deepseek-chat",
		messages: [
			{ role: "user" as const, content: "old request" },
			{ role: "assistant" as const, content: "old reply" },
			{ role: "user" as const, content: "new request" },
		],
	};
	await client.sendMessage({ message: "unused", conversationId: "ses_full", history });
	expect(visits).toEqual(["https://chat.deepseek.com/"]);
	expect(prompts[0]).toBe("Human: new request");
	expect(prompts[1]).toContain("Human: new request");
	expect(url).toBe("https://chat.deepseek.com/a/chat/s/new-chat");
	expect(getDeepSeekChatRoute("ses_full")).toBe(url);
});
