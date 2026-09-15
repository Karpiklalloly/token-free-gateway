import { describe, expect, test } from "bun:test";
import { parseClaudeStream } from "../src/providers/claude/stream.ts";

function createCapturingClient() {
	let got: any = null;
	const encoder = new TextEncoder();
	return {
		captured: () => got,
		client: {
			providerId: "test-provider",
			init: async () => {},
			sendMessage: async (params: any) => {
				got = params;
				const sseData = JSON.stringify({ type: "content_block_delta", delta: { text: "Hi" } });
				return new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
						controller.close();
					},
				});
			},
			parseStream: (body: ReadableStream<Uint8Array>, onDelta?: (d: string) => void) =>
				parseClaudeStream(body, onDelta),
			listModels: () => [{ id: "test-model", name: "Test" }],
		},
	};
}

describe("reasoning_effort passthrough", () => {
	test("non-streaming forwards reasoningEffort", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const { client, captured } = createCapturingClient();
		const res = await handleChatCompletions(
			{
				model: "test",
				messages: [{ role: "user", content: "Hi" }],
				reasoning_effort: "high",
			} as any,
			client as any,
		);
		expect(res.status).toBe(200);
		expect(captured()?.reasoningEffort).toBe("high");
	});

	test("omitted effort forwards undefined", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const { client, captured } = createCapturingClient();
		const res = await handleChatCompletions(
			{ model: "test", messages: [{ role: "user", content: "Hi" }] } as any,
			client as any,
		);
		expect(res.status).toBe(200);
		expect(captured()?.reasoningEffort).toBeUndefined();
	});
});
