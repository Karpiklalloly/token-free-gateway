import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelInfo } from "./types.ts";

export interface CachedProviderModels {
	models: ModelInfo[];
	updatedAt: string;
}

export type ModelsCache = Record<string, CachedProviderModels>;

/** Cache path. Explicit override wins; otherwise sits next to the auth store. */
export function getModelsCachePath(): string {
	if (process.env.TFG_MODELS_CACHE_PATH) return process.env.TFG_MODELS_CACHE_PATH;
	const storePath =
		process.env.TFG_STORE_PATH ?? join(homedir(), ".token-free-gateway", "auth-profiles.json");
	return join(dirname(storePath), "models-cache.json");
}

export function loadModelsCache(): ModelsCache {
	try {
		const p = getModelsCachePath();
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")) as ModelsCache;
	} catch (e) {
		console.warn(`[model-cache] Failed to load: ${e}`);
	}
	return {};
}

export function saveModelsCache(cache: ModelsCache): void {
	const p = getModelsCachePath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8");
}

export function getCachedModels(providerId: string): ModelInfo[] | null {
	return loadModelsCache()[providerId]?.models ?? null;
}

export function setCachedModels(providerId: string, models: ModelInfo[]): void {
	const cache = loadModelsCache();
	cache[providerId] = { models, updatedAt: new Date().toISOString() };
	saveModelsCache(cache);
}
