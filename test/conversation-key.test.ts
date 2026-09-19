import { describe, expect, test } from "bun:test";
import { resolveConversationKey } from "../src/openai/conversation-key.ts";

describe("resolveConversationKey", () => {
	test("uses the OpenCode session header and trims whitespace", () => {
		const request = new Request("http://localhost/v1/chat/completions", {
			headers: { "X-TFG-Conversation-ID": "  ses_chat_a  " },
		});

		expect(resolveConversationKey(request)).toBe("ses_chat_a");
	});

	test("rejects an absent or blank session header", () => {
		expect(resolveConversationKey(new Request("http://localhost"))).toBeNull();
		expect(
			resolveConversationKey(
				new Request("http://localhost", { headers: { "X-TFG-Conversation-ID": "   " } }),
			),
		).toBeNull();
	});
});
