import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { effortToThink, parseModelString, type ReasoningEffort } from "../model-spec.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { StreamResult } from "../types.ts";
import type { GlmIntlWebAuth } from "./auth.ts";
import { parseGlmIntlStream } from "./stream.ts";

export function resolveGlmThink(
	suffixThink: boolean | undefined,
	reasoningEffort?: ReasoningEffort,
): boolean | undefined {
	return suffixThink ?? effortToThink(reasoningEffort);
}

export class GlmIntlWebClient extends BaseDomClient<GlmIntlWebAuth> {
	readonly providerId = "glm-intl-web";

	protected readonly config: DomClientConfig = {
		hostKey: "chat.z.ai",
		startUrl: "https://chat.z.ai/",
		cookieDomain: ".z.ai",
		models: [
			{ id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
			{ id: "glm-5.3", name: "GLM 5.3" },
			{ id: "glm-5.2", name: "GLM 5.2" },
		],
		pollIntervalMs: 900,
		maxWaitMs: 120_000,
		stabilityThreshold: 3,
	};

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie, this.config.cookieDomain);
	}

	private normalizeLabel(label: string): string {
		return label.trim().toLowerCase().replace(/\s+/g, "-");
	}

	// Ensure the site picker shows the requested model. Throws, never sends to a wrong model.
	// NOTE: concurrent requests for different models on the shared tab are last-write-wins
	// (single-user gateway; no serialization by design).
	private async ensureModel(page: Page, baseId: string): Promise<void> {
		const picker = page.getByRole("button", { name: "Select a model" });
		const current = this.normalizeLabel((await picker.textContent({ timeout: 10000 })) ?? "");
		if (current === baseId) return;
		// The site disables the picker while a response is generating; wait for it.
		await page
			.waitForFunction(
				() => {
					const el = document.querySelector(
						"button[aria-label='Select a model']",
					) as HTMLButtonElement | null;
					return el && !el.disabled;
				},
				null,
				{ timeout: 60000, polling: 1000 },
			)
			.catch(() => {});
		await picker.click({ timeout: 10000 });
		await page.waitForTimeout(1500);
		const menu = page.locator("[role='menu'] button");
		const n = await menu.count();
		let picked = false;
		for (let i = 0; i < n; i++) {
			// Menu text holds name + description (e.g. "GLM-5.3 Flagship model, ...");
			// the first token is the display name. Exact-match it so Flash never wins.
			const raw = ((await menu.nth(i).textContent()) ?? "").trim().split(/\s+/)[0] ?? "";
			if (this.normalizeLabel(raw) === baseId) {
				await menu.nth(i).click({ timeout: 10000 });
				picked = true;
				break;
			}
		}
		if (!picked) {
			await page.keyboard.press("Escape");
			throw new Error(`glm-intl-web: model "${baseId}" not found in picker menu`);
		}
		await page
			.waitForFunction(
				(expected: string) => {
					const el = document.querySelector("button[aria-label='Select a model']");
					return (el?.textContent || "").trim().toLowerCase().replace(/\s+/g, "-") === expected;
				},
				baseId,
				{ timeout: 10000, polling: 500 },
			)
			.catch(() => {});
		const after = this.normalizeLabel((await picker.textContent({ timeout: 5000 })) ?? "");
		if (after !== baseId) {
			throw new Error(
				`glm-intl-web: failed to select model "${baseId}" (picker still shows "${after}")`,
			);
		}
	}

	// Set the Deep Think switch to want (true/false). undefined leaves the UI untouched.
	// The site exposes Deep Think as a dropdown pill ("Deep Think <level>"); on/off is a
	// role=switch inside the menu. The Low/High/Max effort level is left as-is.
	// The switch can be disabled by the site for some models: a matching state is a
	// no-op, but a requested change then throws instead of silently doing nothing.
	private async ensureThink(page: Page, want: boolean | undefined): Promise<void> {
		if (want === undefined) return;
		const pill = page.locator(
			"xpath=//span[normalize-space(text())='Deep Think']/parent::*[1]",
		);
		if ((await pill.count()) === 0) {
			throw new Error("glm-intl-web: Deep Think toggle not found");
		}
		await pill.first().click({ timeout: 10000 });
		await page.waitForTimeout(1000);
		try {
			const sw = page.locator("[role='menu'] [role='switch']");
			if ((await sw.count()) === 0) {
				throw new Error("glm-intl-web: Deep Think switch not found");
			}
			const first = sw.first();
			if (((await first.getAttribute("aria-checked")) === "true") === want) return;
			if (await first.isDisabled()) {
				throw new Error("glm-intl-web: Deep Think switch is disabled by the site");
			}
			await first.click({ timeout: 10000 });
			await page.waitForTimeout(1000);
			if ((await sw.count()) > 0 && ((await first.getAttribute("aria-checked")) === "true") !== want) {
				throw new Error("glm-intl-web: failed to set Deep Think switch");
			}
		} finally {
			await page.keyboard.press("Escape");
		}
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		const spec = parseModelString(params.model);
		await this.ensureModel(page, spec.base);
		await this.ensureThink(page, resolveGlmThink(spec.think, params.reasoningEffort));
		if (!page.url().includes("chat.z.ai")) {
			await page.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded", timeout: 120000 });
		}

		const beforeCount = await page.locator(".chat-assistant").count();

		let sent = false;
		const textarea = page.locator("textarea:visible").first();
		if ((await textarea.count()) > 0) {
			await textarea.click({ timeout: 5000 });
			await pasteText(page, params.message);
			await page.keyboard.press("Enter");
			sent = true;
		}
		if (!sent) {
			const editable = page.locator('[contenteditable="true"]:visible').first();
			if ((await editable.count()) > 0) {
				await editable.click({ timeout: 5000 });
				await pasteText(page, params.message);
				await page.keyboard.press("Enter");
				sent = true;
			}
		}
		if (!sent) {
			const input = page.locator('input[type="text"]:visible').first();
			if ((await input.count()) > 0) {
				await input.click({ timeout: 5000 });
				await input.fill(params.message);
				const sendBtn = page
					.locator('button.sendMessageButton, button[aria-label*="Send"], button:has-text("发送")')
					.first();
				if ((await sendBtn.count()) > 0) {
					await sendBtn.click();
					sent = true;
				} else {
					await input.press("Enter");
					sent = true;
				}
			}
		}
		if (!sent) throw new Error("GLM Intl UI send failed: no chat input found.");

		await page
			.waitForFunction(
				(prev) => document.querySelectorAll(".chat-assistant").length > prev,
				beforeCount,
				{ timeout: 120000, polling: 500 },
			);

		return this.pollForStableText(async () => {
			return page.evaluate(() => {
				const nodes = Array.from(document.querySelectorAll(".chat-assistant"));
				const latest = nodes[nodes.length - 1] as HTMLElement | undefined;
				return (latest?.innerText ?? "").trim();
			});
		}, params.signal);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseGlmIntlStream(body, onDelta);
	}
}
