import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDeepSeekChatRoute,
	getDeepSeekChatRoutesPath,
	setDeepSeekChatRoute,
} from "../src/providers/deepseek/chat-routes.ts";

let storeDir = "";
let originalStorePath: string | undefined;

beforeEach(() => {
	storeDir = mkdtempSync(join(tmpdir(), "tfg-deepseek-routes-"));
	originalStorePath = process.env.TFG_STORE_PATH;
	process.env.TFG_STORE_PATH = join(storeDir, "auth-profiles.json");
});

afterEach(() => {
	if (originalStorePath === undefined) delete process.env.TFG_STORE_PATH;
	else process.env.TFG_STORE_PATH = originalStorePath;
	rmSync(storeDir, { recursive: true, force: true });
});

test("DeepSeek chat routes round-trip next to the auth store", () => {
	expect(getDeepSeekChatRoute("ses_chat_a")).toBeNull();
	setDeepSeekChatRoute("ses_chat_a", "https://chat.deepseek.com/a/chat/s/chat-a");
	expect(getDeepSeekChatRoute("ses_chat_a")).toBe("https://chat.deepseek.com/a/chat/s/chat-a");
});

test("DeepSeek chat routes recover from corrupt JSON", () => {
	writeFileSync(getDeepSeekChatRoutesPath(), "not json", "utf8");
	expect(getDeepSeekChatRoute("ses_chat_a")).toBeNull();
});
