import { Buffer } from "node:buffer";
import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BrowserManager } from "../../browser/manager.ts";
import type { ChatCompletionRequest, ChatMessage, ImageInput } from "../../openai/types.ts";
import { buildPromptFromMessages } from "../../tool-calling/converter.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { effortToThink, parseModelString, type ReasoningEffort } from "../model-spec.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import { ProviderApiError, type StreamResult } from "../types.ts";
import type { DeepSeekWebCredentials } from "./auth.ts";
import { getDeepSeekChatRoute, setDeepSeekChatRoute } from "./chat-routes.ts";
import { parseDeepSeekStream } from "./stream.ts";

const LENGTH_LIMIT = /^\s*Length limit reached\. Please start a new chat\.\s*$/i;

export function selectDeepSeekMessages(messages: ChatMessage[], continued: boolean): ChatMessage[] {
	if (!continued) {
		const system = messages.filter((message) => message.role === "system" || message.role === "developer");
		return [...system, ...messages.filter((message) => message.role !== "system" && message.role !== "developer").slice(-8)];
	}
	const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
	return messages.slice(lastAssistant + 1).filter((message) => message.role !== "system" && message.role !== "developer");
}

function deepSeekPrompt(history: ChatCompletionRequest, continued: boolean): string {
	const selected = selectDeepSeekMessages(history.messages, continued);
	const prompt = buildPromptFromMessages(selected, history.tools, history.tool_choice).prompt;
	if (continued || prompt.length <= 30_000) return prompt;
	const toolPrompt = buildPromptFromMessages([], history.tools, history.tool_choice).prompt;
	const recent = buildPromptFromMessages(selected).prompt;
	return `${toolPrompt}\n\n[Earlier conversation omitted. Inspect project files if needed.]\n\n${recent.slice(-Math.max(1_000, 30_000 - toolPrompt.length - 80))}`;
}

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

function imageToFile(image: ImageInput, index: number): { name: string; mimeType: string; buffer: Buffer } {
	const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(image.url);
	if (!match) throw new ProviderApiError(400, "deepseek-web: image URL must be a data URL");

	const mimeType = match[1] || "application/octet-stream";
	const buffer = match[2]
		? Buffer.from(match[3] ?? "", "base64")
		: Buffer.from(decodeURIComponent(match[3] ?? ""));
	const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
	return { name: `image-${index}.${extension}`, mimeType, buffer };
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
		images?: ImageInput[];
		history?: ChatCompletionRequest;
	}): Promise<ReadableStream<Uint8Array>> {
		const conversationId = params.conversationId;
		if (!conversationId) {
			throw new ProviderApiError(400, "DeepSeek routing requires a chat identifier");
		}

		const previous = this.tails.get(conversationId) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.tails.set(conversationId, tail);
		await previous;
		try {
			const flags = resolveDeepSeekFlags(params.model, params.reasoningEffort);
			const page = await this.getPageForConversation(conversationId);
			const savedRoute = getDeepSeekChatRoute(conversationId);
			const firstPrompt = params.history ? deepSeekPrompt(params.history, Boolean(savedRoute)) : params.message;
			const send = (message: string) => this.sendViaDom(page, {
				message,
				model: flags.base,
				signal: params.signal,
				reasoningEffort: params.reasoningEffort,
				conversationId,
				images: params.images,
				thinking: flags.thinking,
				search: flags.search,
			});
			let text = await send(firstPrompt);
			if (LENGTH_LIMIT.test(text) && params.history) {
				await page.goto(this.config.startUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
				text = await send(deepSeekPrompt(params.history, false));
				if (LENGTH_LIMIT.test(text)) throw new ProviderApiError(413, "DeepSeek rejected the shortened context; start a new Hermes chat");
			}
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

	private async setToggle(page: Page, labels: RegExp, want: boolean): Promise<void> {
		const toggles = page.locator('[aria-pressed]:visible');
		for (let i = 0, count = await toggles.count(); i < count; i++) {
			const toggle = toggles.nth(i);
			if (!labels.test((await toggle.innerText().catch(() => "")).trim())) continue;
			if ((await toggle.getAttribute("aria-pressed")) !== String(want)) {
				await toggle.click({ timeout: 10_000 });
			}
			return;
		}
		console.warn("[DeepSeek] feature toggle not found; keeping the page default");
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		if (params.thinking !== undefined) {
			await this.setToggle(page, /Deep\s*Think|Глубокое мышление|深度思考|思考/i, params.thinking);
		}
		if (params.search !== undefined) {
			await this.setToggle(page, /\bSearch\b|Умный поиск|联网搜索|搜索/i, params.search);
		}

		const messages = page.locator(".ds-message");
		const beforeCount = await messages.count();
		const previousMessage = messages.last();
		const previousResponse = previousMessage.locator(".ds-assistant-message-main-content");
		const beforeText = beforeCount
			? (await previousResponse.innerText({ timeout: 500 }).catch(() => "")).trim()
			: "";
		const input = page.locator('textarea[placeholder="Message DeepSeek"]:visible').first();
		if ((await input.count()) === 0) throw new Error("deepseek-web: message input not found");
		const inputDeadline = Date.now() + 30_000;
		while (!(await input.isEditable().catch(() => false))) {
			if (Date.now() >= inputDeadline) throw new Error("deepseek-web: message input did not become editable");
			await page.waitForTimeout(250);
		}
		const inputHandle = await input.elementHandle();
		if (!inputHandle) throw new Error("deepseek-web: message input disappeared");
		if (params.images?.length) {
			const fileInput = page.locator('input[type="file"]').first();
			if ((await fileInput.count()) === 0) throw new Error("deepseek-web: file input not found");
			await fileInput.setInputFiles(params.images.map(imageToFile));
			await page.waitForTimeout(400);
		}
		await input.click({ timeout: 10_000 });
		if (params.message) await pasteText(page, params.message, inputHandle);

		let submitted = false;
		try {
			await input.press("Enter");
			const submissionDeadline = Date.now() + 3_000;
			while (Date.now() < submissionDeadline) {
				if ((await messages.count().catch(() => beforeCount)) > beforeCount) {
					submitted = true;
					break;
				}
				await page.waitForTimeout(100);
			}
		} catch {
			submitted = false;
		}
		if (!submitted) {
			let sendButton = page
				.locator(
					'.chat-input-send-button:visible button, .chat-input-send-button:visible [role="button"], .chat-input-send-button:visible',
				)
				.last();
			if ((await sendButton.count()) === 0) {
				sendButton = page
					.locator(
						'button[type="submit"]:visible, button[aria-label*="send" i]:visible, button[aria-label*="发送"]:visible, [role="button"]:visible',
					)
					.last();
			}
			if ((await sendButton.count()) > 0) {
				const sendDeadline = Date.now() + 30_000;
				while (true) {
					const enabled = await sendButton.isEnabled().catch(() => false);
					const active = await sendButton
						.evaluate((element) => {
							const style = window.getComputedStyle(element);
							return (
								!element.matches(":disabled") &&
								element.getAttribute("aria-disabled") !== "true" &&
								element.getAttribute("data-disabled") !== "true" &&
								!element.classList.contains("disabled") &&
								style.pointerEvents !== "none"
							);
						})
						.catch(() => false);
					if (enabled && active) break;
					if (Date.now() >= sendDeadline) {
						throw new Error("deepseek-web: send button did not become enabled");
					}
					await page.waitForTimeout(100);
				}
				await sendButton.click({ timeout: 10_000 });
			} else {
				await page.keyboard.press("Enter");
			}
		}

		const message = messages.last();
		const interval = this.config.pollIntervalMs ?? 750;
		const maxWait = this.config.maxWaitMs ?? 300_000;
		const threshold = this.config.stabilityThreshold ?? 2;
		let lastText = "";
		let stableCount = 0;
		let retryClicks = 0;

		for (let elapsed = 0; elapsed < maxWait; elapsed += interval) {
			if (params.signal?.aborted) throw new Error("deepseek-web request aborted");
			const retryButton = page.getByRole("button", { name: /^Retry$/i }).last();
			const retryFallback = page.locator('[title="Retry"]:visible, [aria-label="Retry"]:visible').last();
			const visibleRetry = await retryButton.isVisible().catch(() => false)
				? retryButton
				: await retryFallback.isVisible().catch(() => false) ? retryFallback : null;
			if (visibleRetry) {
				if (retryClicks++ >= 2) throw new ProviderApiError(502, "DeepSeek failed after two automatic retries");
				console.warn(`[DeepSeek] Retrying failed generation (${retryClicks}/2)`);
				await visibleRetry.click({ timeout: 10_000 });
				lastText = "";
				stableCount = 0;
				await page.waitForTimeout(interval);
				continue;
			}
			const continueButton = page.getByRole("button", { name: /^Continue$/i }).last();
			if (await continueButton.isVisible().catch(() => false)) {
				await continueButton.click({ timeout: 10_000 });
				lastText = "";
				stableCount = 0;
				await page.waitForTimeout(interval);
				continue;
			}

			const response = message.locator(".ds-assistant-message-main-content");
			const text = (await response.innerText({ timeout: 500 }).catch(() => "")).trim();
			if (text && text !== params.message && text !== beforeText) {
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
