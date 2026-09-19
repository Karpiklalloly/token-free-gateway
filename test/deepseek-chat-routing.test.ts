import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "../src/browser/manager.ts";
import { DeepSeekWebClient } from "../src/providers/deepseek/client.ts";
import { setDeepSeekChatRoute } from "../src/providers/deepseek/chat-routes.ts";

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
