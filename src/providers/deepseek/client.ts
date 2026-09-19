import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { effortToThink, parseModelString, type ReasoningEffort } from "../model-spec.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { StreamResult } from "../types.ts";
import type { DeepSeekWebCredentials } from "./auth.ts";
import { parseDeepSeekStream } from "./stream.ts";

export function resolveDeepSeekFlags(
	model: string | undefined,
	reasoningEffort?: ReasoningEffort,
	legacySearchEnabled?: boolean,
): { base: string; thinking: boolean; search: boolean } {
	const spec = parseModelString(model || "deepseek-chat");
	const isReasoner = spec.base === "deepseek-reasoner";
	return {
		base: spec.base,
		thinking: spec.think ?? effortToThink(reasoningEffort) ?? isReasoner,
		search: spec.search ?? legacySearchEnabled ?? true,
	};
}

export class DeepSeekWebClient extends BaseDomClient<DeepSeekWebCredentials> {
	readonly providerId = "deepseek-web";

	protected readonly config: DomClientConfig = {
		hostKey: "deepseek.com",
		startUrl: "https://chat.deepseek.com/",
		cookieDomain: ".deepseek.com",
		models: [
			{ id: "deepseek-chat", name: "DeepSeek Chat" },
			{ id: "deepseek-chat:think", name: "DeepSeek Chat (thinking)" },
			{ id: "deepseek-chat:search-off", name: "DeepSeek Chat (no search)" },
			{ id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
			{ id: "deepseek-reasoner:no-think", name: "DeepSeek Reasoner (no thinking)" },
			{ id: "deepseek-reasoner:search-off", name: "DeepSeek Reasoner (no search)" },
		],
	};

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie || "", this.config.cookieDomain);
	}

	protected override async getPage(): Promise<Page> {
		if (this.page) {
			try {
				await this.page.evaluate(() => document.readyState);
				return this.page;
			} catch {
				this.page = null;
			}
		}

		const browser = BrowserManager.getInstance();
		const cookies = this.getCookies();
		if (cookies.length > 0) await browser.addCookies(cookies);
		this.page = await (await browser.getContext()).newPage();
		await this.page.goto(this.config.startUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
		return this.page;
	}

	override async close(): Promise<void> {
		await this.page?.close().catch(() => {});
		this.page = null;
	}

	protected async sendViaDom(_page: Page, _params: NormalizedSendParams): Promise<string> {
		throw new Error("DeepSeek DOM send is not implemented");
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseDeepSeekStream(body, onDelta);
	}
}
