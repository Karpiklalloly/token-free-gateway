import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStorePath } from "../auth-store.ts";

type DeepSeekChatRoutes = Record<string, { url: string; updatedAt: string }>;

export function getDeepSeekChatRoutesPath(): string {
	return join(dirname(getStorePath()), "deepseek-chat-routes.json");
}

function loadDeepSeekChatRoutes(): DeepSeekChatRoutes {
	try {
		const path = getDeepSeekChatRoutesPath();
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as DeepSeekChatRoutes;
	} catch (error) {
		console.warn(`[deepseek-chat-routes] Failed to load routes: ${error}`);
	}
	return {};
}

export function getDeepSeekChatRoute(key: string): string | null {
	return loadDeepSeekChatRoutes()[key]?.url ?? null;
}

export function setDeepSeekChatRoute(key: string, url: string): void {
	if (!key.trim()) throw new Error("DeepSeek chat route key must not be blank");
	const parsed = new URL(url);
	if (parsed.origin !== "https://chat.deepseek.com") {
		throw new Error("DeepSeek chat route must use chat.deepseek.com");
	}

	const path = getDeepSeekChatRoutesPath();
	const routes = loadDeepSeekChatRoutes();
	routes[key] = { url, updatedAt: new Date().toISOString() };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(routes, null, 2), "utf8");
}
