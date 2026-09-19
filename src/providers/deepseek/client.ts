import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import { pasteText } from "../../browser/dom-input.ts";
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
		pollIntervalMs: 750,
		maxWaitMs: 300_000,
		stabilityThreshold: 2,
	};
	private tail: Promise<void> = Promise.resolve();

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

	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		reasoningEffort?: ReasoningEffort;
	}): Promise<ReadableStream<Uint8Array>> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await super.sendMessage(params);
		} finally {
			release();
		}
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		const beforeCount = await page.locator(".ds-message").count();
		const input = page.locator('textarea[placeholder="Message DeepSeek"]:visible').first();
		if ((await input.count()) === 0) throw new Error("deepseek-web: message input not found");
		const inputHandle = await input.elementHandle();
		if (!inputHandle) throw new Error("deepseek-web: message input disappeared");
		await input.click({ timeout: 10_000 });
		await pasteText(page, params.message, inputHandle);
		await page.keyboard.press("Enter");

		await page.waitForFunction(
			(previousMessages) => document.querySelectorAll(".ds-message").length > previousMessages + 1,
			beforeCount,
			{ timeout: this.config.maxWaitMs, polling: 500 },
		);

		const message = page.locator(".ds-message").last();
		const interval = this.config.pollIntervalMs ?? 750;
		const maxWait = this.config.maxWaitMs ?? 300_000;
		const threshold = this.config.stabilityThreshold ?? 2;
		let lastText = "";
		let stableCount = 0;

		for (let elapsed = 0; elapsed < maxWait; elapsed += interval) {
			if (params.signal?.aborted) throw new Error("deepseek-web request aborted");
			const continueButton = page.getByRole("button", { name: /^Continue$/i }).last();
			if (await continueButton.isVisible().catch(() => false)) {
				await continueButton.click({ timeout: 10_000 });
				lastText = "";
				stableCount = 0;
				await page.waitForTimeout(interval);
				continue;
			}

			const markdown = message.locator(".ds-markdown").last();
			const text = (
				(await markdown.innerText().catch(() => "")) || (await message.innerText().catch(() => ""))
			).trim();
			if (text && text !== params.message) {
				if (text === lastText) {
					stableCount++;
					if (stableCount >= threshold) return text;
				} else {
					lastText = text;
					stableCount = 0;
				}
			}
			await page.waitForTimeout(interval);
		}

		throw new Error("deepseek-web: response did not settle before timeout");
	}

	protected override formatSsePayload(text: string): string {
		return `data: ${JSON.stringify({ v: text })}\n\n`;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseDeepSeekStream(body, onDelta);
	}
}
