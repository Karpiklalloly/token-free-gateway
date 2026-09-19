import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { effortToThink, parseModelString, type ReasoningEffort } from "../model-spec.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import { ProviderApiError, type StreamResult } from "../types.ts";
import type { DeepSeekWebCredentials } from "./auth.ts";
import { getDeepSeekChatRoute, setDeepSeekChatRoute } from "./chat-routes.ts";
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
	private readonly pages = new Map<string, Page>();
	private readonly tails = new Map<string, Promise<void>>();

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie || "", this.config.cookieDomain);
	}

	override async init(): Promise<void> {}

	protected async getPageForConversation(conversationId: string): Promise<Page> {
		const existing = this.pages.get(conversationId);
		if (existing) {
			try {
				await existing.evaluate(() => document.readyState);
				return existing;
			} catch {
				this.pages.delete(conversationId);
			}
		}

		const browser = BrowserManager.getInstance();
		const cookies = this.getCookies();
		if (cookies.length > 0) await browser.addCookies(cookies);
		const page = await (await browser.getContext()).newPage();
		await page.goto(getDeepSeekChatRoute(conversationId) ?? this.config.startUrl, {
			waitUntil: "domcontentloaded",
			timeout: 120_000,
		});
		this.pages.set(conversationId, page);
		return page;
	}

	override async close(): Promise<void> {
		await Promise.all([...this.pages.values()].map((page) => page.close().catch(() => {})));
		this.pages.clear();
		this.tails.clear();
		this.page = null;
	}

	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		reasoningEffort?: ReasoningEffort;
		conversationId?: string;
	}): Promise<ReadableStream<Uint8Array>> {
		const conversationId = params.conversationId;
		if (!conversationId) {
			throw new ProviderApiError(400, "DeepSeek routing requires an OpenCode/Hermes chat identifier");
		}

		const previous = this.tails.get(conversationId) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.tails.set(conversationId, tail);
		await previous;
		try {
			const page = await this.getPageForConversation(conversationId);
			const text = await this.sendViaDom(page, {
				message: params.message,
				model: params.model || this.config.models[0]?.id || "default",
				signal: params.signal,
				reasoningEffort: params.reasoningEffort,
				conversationId,
			});
			if (!text) throw new Error("deepseek-web: no assistant reply detected");

			const url = page.url();
			if (url.startsWith("https://chat.deepseek.com/a/chat/s/")) {
				setDeepSeekChatRoute(conversationId, url);
			}
			return textToStream(this.formatSsePayload(text));
		} finally {
			release();
			if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
		}
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		const messages = page.locator(".ds-message");
		const beforeCount = await messages.count();
		const beforeText = (await messages.last().innerText().catch(() => "")).trim();
		const input = page.locator('textarea[placeholder="Message DeepSeek"]:visible').first();
		if ((await input.count()) === 0) throw new Error("deepseek-web: message input not found");
		await input.click({ timeout: 10_000 });
		await input.fill(params.message);
		await page.keyboard.press("Enter");

		await page.waitForFunction(
			(previous) => {
				const messages = document.querySelectorAll(".ds-message");
				const lastText = messages[messages.length - 1]?.textContent?.trim() ?? "";
				return messages.length > previous.count || lastText !== previous.text;
			},
			{ count: beforeCount, text: beforeText },
			{ timeout: this.config.maxWaitMs, polling: 500 },
		);

		const message = messages.last();
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
