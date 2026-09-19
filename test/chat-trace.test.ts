import { describe, expect, test } from "bun:test";
import { formatChatTrace } from "../src/openai/chat-trace.ts";

describe("formatChatTrace", () => {
	test("correlates a request without exposing its contents", () => {
		const trace = {
			id: "abc123",
			conversationId: "ses_child",
			model: "deepseek-chat:think",
			stream: true,
		};

		expect(formatChatTrace(trace, { event: "received" })).toBe(
			"[chat-trace] abc123 received chat=ses_child model=deepseek-chat:think stream=true",
		);
		expect(
			formatChatTrace(trace, { event: "completed", status: 200, elapsedMs: 42 }),
		).toBe("[chat-trace] abc123 completed status=200 elapsed_ms=42");
	});
});
