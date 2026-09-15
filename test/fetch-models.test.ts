import { describe, expect, test } from "bun:test";
import { BaseApiClient } from "../src/providers/factory/base-api-client.ts";
import type { BrowserCookie } from "../src/providers/shared/cookie-parser.ts";
import type { EvalResult } from "../src/providers/shared/eval-helpers.ts";
import type { Page } from "playwright-core";

class FakeApiClient extends BaseApiClient<unknown> {
	readonly providerId = "fake-web";
	protected readonly config = {
		hostKey: "fake",
		startUrl: "https://example.com",
		cookieDomain: "example.com",
		defaultModel: "m-static",
		models: [{ id: "m-static", name: "Static" }],
	};
	protected getCookies(): BrowserCookie[] {
		return [];
	}
	protected callApi(_page: Page, _params: never): Promise<EvalResult> {
		throw new Error("not needed");
	}
	protected parseStreamImpl(): Promise<never> {
		throw new Error("not needed");
	}
}

describe("fetchModels default", () => {
	test("BaseApiClient falls back to static config models", async () => {
		const c = new FakeApiClient({});
		await expect(c.fetchModels()).resolves.toEqual([{ id: "m-static", name: "Static" }]);
	});
});
