import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCredentials } from "../src/providers/auth-store.ts";
import { setCachedModels } from "../src/providers/model-cache.ts";
import { listAllModels, refreshModels } from "../src/providers/registry.ts";

const TEST_STORE_PATH = join(tmpdir(), `tfg-test-store-${process.pid}.json`);
const TEST_CACHE_PATH = join(tmpdir(), `tfg-test-mcache-${process.pid}.json`);

afterAll(() => {
	delete process.env.TFG_STORE_PATH;
	delete process.env.TFG_MODELS_CACHE_PATH;
	for (const p of [TEST_STORE_PATH, TEST_CACHE_PATH]) if (existsSync(p)) rmSync(p);
});

afterEach(() => {
	for (const p of [TEST_STORE_PATH, TEST_CACHE_PATH]) if (existsSync(p)) rmSync(p);
	process.env.TFG_STORE_PATH = TEST_STORE_PATH;
	process.env.TFG_MODELS_CACHE_PATH = TEST_CACHE_PATH;
});

beforeEach(() => {
	for (const p of [TEST_STORE_PATH, TEST_CACHE_PATH]) if (existsSync(p)) rmSync(p);
	process.env.TFG_STORE_PATH = TEST_STORE_PATH;
	process.env.TFG_MODELS_CACHE_PATH = TEST_CACHE_PATH;
});

describe("models refresh", () => {
	test("refreshModels with no authorized providers returns empty report", async () => {
		const report = await refreshModels();
		expect(report.refreshed).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.models).toBe(0);
	});

	test("refreshModels with unknown provider id reports failure", async () => {
		const report = await refreshModels("nope-web");
		expect(report.refreshed).toEqual([]);
		expect(report.failed.length).toBe(1);
		expect(report.failed[0]?.provider).toBe("nope-web");
	});

	test("listAllModels prefers cache over static catalog", async () => {
		saveCredentials("gemini-web", { probe: true });
		const before = await listAllModels();
		expect(before.some((m) => m.id === "gemini-pro")).toBe(true);
		setCachedModels("gemini-web", [{ id: "gemini-live", name: "Gemini Live" }]);
		const after = await listAllModels();
		expect(after.some((m) => m.id === "gemini-live")).toBe(true);
		expect(after.some((m) => m.id === "gemini-pro")).toBe(false);
	});
});
