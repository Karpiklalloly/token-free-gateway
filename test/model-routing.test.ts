import { afterEach, describe, expect, test } from "bun:test";
import { resolveModelToProvider } from "../src/providers/registry.ts";

afterEach(() => {
	delete process.env.TFG_STORE_PATH;
	delete process.env.TFG_MODELS_CACHE_PATH;
});

describe("suffix-aware routing", () => {
	test("resolves suffixed ids by base", async () => {
		expect(await resolveModelToProvider("deepseek-reasoner:search-off")).toBe("deepseek-web");
		expect(await resolveModelToProvider("deepseek-chat:think")).toBe("deepseek-web");
		expect(await resolveModelToProvider("glm-5.3:think")).toBe("glm-intl-web");
	});

	test("plain ids still resolve", async () => {
		expect(await resolveModelToProvider("deepseek-chat")).toBe("deepseek-web");
	});

	test("unknown base returns null", async () => {
		expect(await resolveModelToProvider("nope:think")).toBeNull();
	});
});
