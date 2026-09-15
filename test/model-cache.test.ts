import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getCachedModels,
	getModelsCachePath,
	loadModelsCache,
	saveModelsCache,
	setCachedModels,
} from "../src/providers/model-cache.ts";

const TEST_CACHE_PATH = join(tmpdir(), `tfg-test-models-${process.pid}.json`);

afterAll(() => {
	delete process.env.TFG_MODELS_CACHE_PATH;
	if (existsSync(TEST_CACHE_PATH)) rmSync(TEST_CACHE_PATH);
});

afterEach(() => {
	if (existsSync(TEST_CACHE_PATH)) rmSync(TEST_CACHE_PATH);
	delete process.env.TFG_MODELS_CACHE_PATH;
});

describe("model-cache", () => {
	test("loadModelsCache returns {} when no file exists", () => {
		process.env.TFG_MODELS_CACHE_PATH = TEST_CACHE_PATH;
		expect(loadModelsCache()).toEqual({});
	});

	test("setCachedModels and getCachedModels round-trip", () => {
		process.env.TFG_MODELS_CACHE_PATH = TEST_CACHE_PATH;
		setCachedModels("gemini-web", [{ id: "gemini-live", name: "Gemini Live" }]);
		expect(getCachedModels("gemini-web")).toEqual([
			{ id: "gemini-live", name: "Gemini Live" },
		]);
	});

	test("getCachedModels returns null for unknown provider", () => {
		process.env.TFG_MODELS_CACHE_PATH = TEST_CACHE_PATH;
		expect(getCachedModels("nope")).toBeNull();
	});

	test("saveModelsCache and loadModelsCache round-trip", () => {
		process.env.TFG_MODELS_CACHE_PATH = TEST_CACHE_PATH;
		saveModelsCache({
			"a-web": {
				models: [{ id: "m1", name: "M1" }],
				updatedAt: "2026-09-15T00:00:00.000Z",
			},
		});
		const loaded = loadModelsCache();
		expect(loaded["a-web"]?.models).toEqual([{ id: "m1", name: "M1" }]);
	});

	test("getModelsCachePath honors TFG_MODELS_CACHE_PATH", () => {
		process.env.TFG_MODELS_CACHE_PATH = TEST_CACHE_PATH;
		expect(getModelsCachePath()).toBe(TEST_CACHE_PATH);
	});
});
