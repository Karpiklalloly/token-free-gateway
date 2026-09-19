import { describe, expect, test } from "bun:test";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/openai/types.ts";
import { parseClaudeStream } from "../src/providers/claude/stream.ts";

function createMockClient(responseText: string) {
	return {
		providerId: "test-provider",
		init: async () => {},
		sendMessage: async () => {
			const encoder = new TextEncoder();
			const sseData = JSON.stringify({
				type: "content_block_delta",
				delta: { text: responseText },
			});
			return new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
					controller.close();
				},
			});
		},
		parseStream: async (body: ReadableStream<Uint8Array>, onDelta?: (d: string) => void) =>
			parseClaudeStream(body, onDelta),
		listModels: () => [{ id: "test-model", name: "Test" }],
	};
}

describe("chat completions handler (unit)", () => {
	test("forwards a conversation ID to the provider", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		let receivedConversationId: string | undefined;
		const client = {
			...createMockClient("Hello"),
			sendMessage: async (params: { conversationId?: string }) => {
				receivedConversationId = params.conversationId;
				return createMockClient("Hello").sendMessage();
			},
		};

		const response = await handleChatCompletions(
			{ model: "test", messages: [{ role: "user", content: "Hi" }] },
			client as any,
			{ conversationId: "ses_chat_a" } as any,
		);

		expect(response.status).toBe(200);
		expect(receivedConversationId).toBe("ses_chat_a");
	});

	test("rejects empty messages", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const client = createMockClient("Hello");

		const body: ChatCompletionRequest = { model: "test", messages: [] };
		const res = await handleChatCompletions(body, client as any);
		expect(res.status).toBe(400);

		const json = (await res.json()) as { error: { message: string } };
		expect(json.error.message).toContain("messages");
	});

	test("rejects missing model", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const client = createMockClient("Hello");

		const body = {
			messages: [{ role: "user", content: "Hi" }],
		} as unknown as ChatCompletionRequest;
		const res = await handleChatCompletions(body, client as any);
		expect(res.status).toBe(400);

		const json = (await res.json()) as { error: { message: string } };
		expect(json.error.message).toContain("model");
	});
});

describe("chat completions response format", () => {
	test("non-streaming response has correct OpenAI shape", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const mockClient = createMockClient("Test response");

		const body: ChatCompletionRequest = {
			model: "test-model",
			messages: [{ role: "user", content: "Hi" }],
		};

		const res = await handleChatCompletions(body, mockClient as any);
		expect(res.status).toBe(200);

		const json = (await res.json()) as ChatCompletionResponse;
		expect(json.object).toBe("chat.completion");
		expect(json.id).toMatch(/^chatcmpl-/);
		expect(json.system_fingerprint).toBeDefined();
		expect(json.choices).toHaveLength(1);
		expect(json.choices[0]?.message.role).toBe("assistant");
		expect(json.choices[0]?.finish_reason).toBe("stop");
		expect(json.usage).toBeDefined();
		expect(json.usage.prompt_tokens).toBeGreaterThan(0);
		expect(json.usage.total_tokens).toBeGreaterThan(0);
	});

	test("streaming response produces valid SSE", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const mockClient = createMockClient("Streamed!");

		const body: ChatCompletionRequest = {
			model: "test",
			messages: [{ role: "user", content: "Hi" }],
			stream: true,
		};

		const res = await handleChatCompletions(body, mockClient as any);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");

		const text = await res.text();
		expect(text).toContain("data: ");
		expect(text).toContain('"chat.completion.chunk"');
		expect(text).toContain("[DONE]");
	});

	test("tool_calls response has correct shape", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const toolResponse = '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}}\n```';
		const mockClient = createMockClient(toolResponse);

		const body: ChatCompletionRequest = {
			model: "test",
			messages: [{ role: "user", content: "List files" }],
			tools: [
				{
					type: "function",
					function: {
						name: "exec",
						description: "Run command",
						parameters: { type: "object", properties: { command: { type: "string" } } },
					},
				},
			],
		};

		const res = await handleChatCompletions(body, mockClient as any);
		expect(res.status).toBe(200);

		const json = (await res.json()) as ChatCompletionResponse;
		expect(json.choices[0]?.finish_reason).toBe("tool_calls");
		expect(json.choices[0]?.message.content).toBeNull();
		expect(json.choices[0]?.message.tool_calls).toHaveLength(1);
		expect(json.choices[0]?.message.tool_calls?.[0]?.type).toBe("function");
		expect(json.choices[0]?.message.tool_calls?.[0]?.id).toMatch(/^call_/);
		expect(json.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("exec");
	});

	test("returns OpenCode task calls for subagent delegation", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const mockClient = createMockClient(
			'```tool_json\n{"tool":"task","parameters":{"description":"Inspect project","prompt":"Inspect the project and report its structure.","subagent_type":"general"}}\n```',
		);
		const body: ChatCompletionRequest = {
			model: "test",
			messages: [{ role: "user", content: "Delegate project inspection" }],
			tools: [
				{
					type: "function",
					function: {
						name: "task",
						description: "Launch a subagent",
						parameters: {
							type: "object",
							properties: {
								description: { type: "string" },
								prompt: { type: "string" },
								subagent_type: { type: "string" },
							},
							required: ["description", "prompt", "subagent_type"],
						},
					},
				},
			],
		};

		const response = await handleChatCompletions(body, mockClient as any);
		const json = (await response.json()) as ChatCompletionResponse;
		const task = json.choices[0]?.message.tool_calls?.[0];
		expect(json.choices[0]?.finish_reason).toBe("tool_calls");
		expect(task?.function.name).toBe("task");
		expect(JSON.parse(task?.function.arguments ?? "{}")).toEqual({
			description: "Inspect project",
			prompt: "Inspect the project and report its structure.",
			subagent_type: "general",
		});
	});

	test("delegates a DeepSeek brainstorming call to an OpenCode subagent", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const mockClient = createMockClient(
			'```tool_json\n{"tool":"skill","parameters":{"name":"brainstorming"}}\n```',
		);
		const body: ChatCompletionRequest = {
			model: "deepseek-chat",
			messages: [
				{
					role: "user",
					content:
						"<EXTREMELY_IMPORTANT>\nYou have superpowers.\n</EXTREMELY_IMPORTANT>\nImplement the requested feature",
				},
			],
			tools: [
				{
					type: "function",
					function: { name: "skill", parameters: { type: "object" } },
				},
				{
					type: "function",
					function: { name: "task", parameters: { type: "object" } },
				},
			],
		};

		const response = await handleChatCompletions(body, mockClient as any);
		const json = (await response.json()) as ChatCompletionResponse;
		const task = json.choices[0]?.message.tool_calls?.[0];
		expect(json.choices[0]?.finish_reason).toBe("tool_calls");
		expect(task?.function.name).toBe("task");
		expect(JSON.parse(task?.function.arguments ?? "{}")).toEqual({
			description: "Complete user task",
			prompt:
				"Complete the following task independently and return the result to the parent agent:\n\nImplement the requested feature",
			subagent_type: "general",
		});
	});

	test("multi-turn tool flow (step 4: tool result → final answer)", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const mockClient = createMockClient("The directory contains file1.txt and file2.txt.");

		const body: ChatCompletionRequest = {
			model: "test",
			messages: [
				{ role: "user", content: "List files" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_abc123",
							type: "function",
							function: { name: "exec", arguments: '{"command":"ls"}' },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_abc123",
					content: "file1.txt\nfile2.txt",
				},
			],
		};

		const res = await handleChatCompletions(body, mockClient as any);
		expect(res.status).toBe(200);

		const json = (await res.json()) as ChatCompletionResponse;
		expect(json.choices[0]?.finish_reason).toBe("stop");
		expect(json.choices[0]?.message.content).toContain("file1.txt");
		expect(json.choices[0]?.message.tool_calls).toBeUndefined();
	});
});
