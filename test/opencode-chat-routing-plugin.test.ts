import { expect, test } from "bun:test";
import { DeepSeekChatRouting } from "../.opencode/plugins/deepseek-chat-routing.ts";

test("OpenCode plugin forwards the session ID only to gateway providers", async () => {
	const hooks = await DeepSeekChatRouting();
	const output = { headers: {} as Record<string, string> };
	await hooks["chat.headers"]?.(
		{ sessionID: "ses_chat_a", provider: { id: "pricol" } } as any,
		output,
	);
	expect(output.headers["X-TFG-Conversation-ID"]).toBe("ses_chat_a");

	const unrelated = { headers: {} as Record<string, string> };
	await hooks["chat.headers"]?.(
		{ sessionID: "ses_chat_b", provider: { id: "llamacpp" } } as any,
		unrelated,
	);
	expect(unrelated.headers["X-TFG-Conversation-ID"]).toBeUndefined();
});
