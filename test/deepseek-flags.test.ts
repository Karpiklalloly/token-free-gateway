import { describe, expect, test } from "bun:test";
import {
	DeepSeekWebClient,
	resolveDeepSeekFlags,
} from "../src/providers/deepseek/client.ts";
import { textToStream } from "../src/providers/shared/stream-helpers.ts";

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

test("DeepSeekWebClient creates an isolated session for every request", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const sessions: string[] = [];
	const calls: Array<{ sessionId: string; parentMessageId: string | number | null | undefined }> = [];
	const internals = client as unknown as {
		getPage: () => Promise<unknown>;
		createChatSession: () => Promise<{ chat_session_id: string }>;
		chatCompletions: (params: {
			sessionId: string;
			parentMessageId?: string | number | null;
		}) => Promise<ReadableStream<Uint8Array>>;
	};
	internals.getPage = async () => ({});
	internals.createChatSession = async () => {
		const sessionId = `session-${sessions.length + 1}`;
		sessions.push(sessionId);
		return { chat_session_id: sessionId };
	};
	internals.chatCompletions = async ({ sessionId, parentMessageId }) => {
		calls.push({ sessionId, parentMessageId });
		return textToStream("");
	};

	await client.init();
	await client.sendMessage({ message: "first" });
	await client.sendMessage({ message: "second" });

	expect(sessions).toEqual(["session-1", "session-2"]);
	expect(calls).toEqual([
		{ sessionId: "session-1", parentMessageId: null },
		{ sessionId: "session-2", parentMessageId: null },
	]);
});

test("DeepSeekWebClient continues a stopped response", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	const calls: Array<{
		sessionId: string;
		parentMessageId?: string | number | null;
		message: string;
		preempt?: boolean;
	}> = [];
	const internals = client as unknown as {
		getPage: () => Promise<unknown>;
		createChatSession: () => Promise<{ chat_session_id: string }>;
		chatCompletions: (params: (typeof calls)[number]) => Promise<ReadableStream<Uint8Array>>;
	};
	internals.getPage = async () => ({});
	internals.createChatSession = async () => ({ chat_session_id: "session-1" });
	internals.chatCompletions = async ({ sessionId, parentMessageId, message, preempt }) => {
		calls.push({ sessionId, parentMessageId, message, preempt });
		return textToStream(
			calls.length === 1
				? 'data: {"response_message_id":42}\n\ndata: {"p":"response/status","o":"SET","v":"STOPPED"}\n\n'
				: 'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"RESUMED"}]}\n\n',
		);
	};

	const stream = await client.sendMessage({ message: "continue this" });
	const result = await client.parseStream(stream);

	expect(result.text).toBe("RESUMED");
	expect(calls).toEqual([
		{ sessionId: "session-1", parentMessageId: null, message: "continue this" },
		{ sessionId: "session-1", parentMessageId: 42, message: "", preempt: true },
	]);
});

test("DeepSeekWebClient stops after three unsuccessful continuations", async () => {
	const client = new DeepSeekWebClient({ cookie: "", bearer: "", userAgent: "test" });
	let calls = 0;
	const internals = client as unknown as {
		getPage: () => Promise<unknown>;
		createChatSession: () => Promise<{ chat_session_id: string }>;
		chatCompletions: () => Promise<ReadableStream<Uint8Array>>;
	};
	internals.getPage = async () => ({});
	internals.createChatSession = async () => ({ chat_session_id: "session-1" });
	internals.chatCompletions = async () => {
		calls++;
		return textToStream(
			`data: {"response_message_id":${calls}}\n\ndata: {"p":"response/status","o":"SET","v":"STOPPED"}\n\n`,
		);
	};

	await expect(client.sendMessage({ message: "keep going" })).rejects.toThrow(
		"stopped after 3 continuations",
	);
	expect(calls).toBe(4);
});
