# Provider Options (DeepSeek + GLM-intl) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-request site options for DeepSeek Web and GLM-intl Web: model pick via `:suffix` ids, thinking on/off via suffix or `reasoning_effort`, search toggle for DeepSeek, DOM model select + Deep Think toggle for GLM-intl.

**Architecture:** New pure `src/providers/model-spec.ts` (suffix parser + effort mapping, fully unit-tested); `reasoningEffort` plumbed through `sendMessage`/`NormalizedSendParams`/chat-completions; DeepSeek resolves flags in-code (verified live: its API takes only `thinking_enabled` + `search_enabled`, no model id); GLM-intl selects models via the proven picker click and toggles Deep Think in-DOM.

**Tech Stack:** Bun, TypeScript, `bun:test`, Playwright (via existing CDP Chrome).

## Global Constraints

- Bun instead of Node.js: `bun test`, `bun index.ts`, `bunx <package>`.
- Test override env: `TFG_STORE_PATH` (existing), `TFG_MODELS_CACHE_PATH` (existing).
- Per-provider refresh timeout: 15000 ms. (Unrelated; do not touch.)
- No live `fetchModels()` overrides in this plan (deferred, separate track).
- `glm` (chatglm.cn) untouched; other 11 providers untouched.
- Suffix beats `reasoning_effort` beats model default. Unknown suffix → 400, never silent-ignore.
- GLM default when neither suffix nor effort given: leave site UI as-is.

---

### Task 1: model-spec parser module

**Files:**
- Create: `src/providers/model-spec.ts`
- Test: `test/model-spec.test.ts`

**Interfaces:**
- Consumes: `ProviderApiError` from `src/providers/types.ts`
- Produces: `ReasoningEffort`, `parseModelString()`, `effortToThink()` for Tasks 2-4

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { effortToThink, parseModelString } from "../src/providers/model-spec.ts";

describe("parseModelString", () => {
	test("base id without suffix passes through", () => {
		expect(parseModelString("deepseek-reasoner")).toEqual({
			base: "deepseek-reasoner",
			think: undefined,
			search: undefined,
		});
	});

	test("parses think and search-off suffixes", () => {
		expect(parseModelString("deepseek-reasoner:no-think:search-off")).toEqual({
			base: "deepseek-reasoner",
			think: false,
			search: false,
		});
	});

	test("later suffix wins on conflict", () => {
		expect(parseModelString("deepseek-chat:no-think:think")).toEqual({
			base: "deepseek-chat",
			think: true,
			search: undefined,
		});
	});

	test("unknown suffix throws 400 ProviderApiError", () => {
		try {
			parseModelString("deepseek-chat:turbo");
			throw new Error("should have thrown");
		} catch (err: any) {
			expect(err.name).toBe("ProviderApiError");
			expect(err.httpStatus).toBe(400);
			expect(String(err.message)).toContain("turbo");
		}
	});
});

describe("effortToThink", () => {
	test("maps efforts to binary thinking", () => {
		expect(effortToThink(undefined)).toBeUndefined();
		expect(effortToThink("none")).toBe(false);
		expect(effortToThink("minimal")).toBe(false);
		expect(effortToThink("low")).toBe(true);
		expect(effortToThink("medium")).toBe(true);
		expect(effortToThink("high")).toBe(true);
		expect(effortToThink("xhigh")).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/model-spec.test.ts`
Expected: FAIL with "Cannot find module" (`src/providers/model-spec.ts` does not exist)

- [ ] **Step 3: Write minimal implementation**

```ts
import { ProviderApiError } from "./types.ts";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ParsedModelSpec {
	base: string;
	think?: boolean;
	search?: boolean;
}

const VALID_SUFFIXES = ["think", "no-think", "search", "search-off"];

/**
 * Split a gateway model id into base id + option flags.
 * e.g. "deepseek-reasoner:no-think:search-off" → base + think=false + search=false.
 * Unknown suffixes throw ProviderApiError(400) — never silently ignored.
 */
export function parseModelString(model: string): ParsedModelSpec {
	const [base, ...suffixes] = model.split(":");
	if (!base) throw new ProviderApiError(400, `Invalid model id "${model}"`);
	let think: boolean | undefined;
	let search: boolean | undefined;
	for (const s of suffixes) {
		if (s === "think") think = true;
		else if (s === "no-think") think = false;
		else if (s === "search") search = true;
		else if (s === "search-off") search = false;
		else {
			throw new ProviderApiError(
				400,
				`Unknown model option ":${s}" in "${model}". Valid options: ${VALID_SUFFIXES.map((v) => `:${v}`).join(", ")}`,
			);
		}
	}
	return { base: base!, think, search };
}

/** Map OpenAI-style reasoning effort to binary site thinking. undefined → leave default. */
export function effortToThink(effort: ReasoningEffort | undefined): boolean | undefined {
	if (effort === undefined) return undefined;
	if (effort === "none" || effort === "minimal") return false;
	return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/model-spec.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/providers/model-spec.ts test/model-spec.test.ts
git commit -m "feat: add model-spec suffix parser"
```

---

### Task 2: reasoningEffort plumbing

**Files:**
- Modify: `src/providers/types.ts` (import type + sendMessage param)
- Modify: `src/providers/factory/types.ts` (NormalizedSendParams)
- Modify: `src/providers/factory/base-api-client.ts` (forward)
- Modify: `src/providers/factory/base-dom-client.ts` (forward)
- Modify: `src/openai/types.ts` (request field)
- Modify: `src/openai/chat-completions.ts` (pass-through, 2 call sites)
- Modify: `src/providers/deepseek/client.ts` (override signature only — flag logic is Task 3)
- Test: `test/reasoning-effort.test.ts`

**Interfaces:**
- Consumes: `ReasoningEffort` (Task 1)
- Produces: `reasoningEffort` on `sendMessage` params + `NormalizedSendParams` for Tasks 3-4

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { parseClaudeStream } from "../src/providers/claude/stream.ts";

function createCapturingClient() {
	let got: any = null;
	const encoder = new TextEncoder();
	return {
		captured: () => got,
		client: {
			providerId: "test-provider",
			init: async () => {},
			sendMessage: async (params: any) => {
				got = params;
				const sseData = JSON.stringify({ type: "content_block_delta", delta: { text: "Hi" } });
				return new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode(`data: ${sseData}\n\n`));
						controller.close();
					},
				});
			},
			parseStream: (body: ReadableStream<Uint8Array>, onDelta?: (d: string) => void) =>
				parseClaudeStream(body, onDelta),
			listModels: () => [{ id: "test-model", name: "Test" }],
		},
	};
}

describe("reasoning_effort passthrough", () => {
	test("non-streaming forwards reasoningEffort", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const { client, captured } = createCapturingClient();
		const res = await handleChatCompletions(
			{
				model: "test",
				messages: [{ role: "user", content: "Hi" }],
				reasoning_effort: "high",
			} as any,
			client as any,
		);
		expect(res.status).toBe(200);
		expect(captured()?.reasoningEffort).toBe("high");
	});

	test("omitted effort forwards undefined", async () => {
		const { handleChatCompletions } = await import("../src/openai/chat-completions.ts");
		const { client, captured } = createCapturingClient();
		const res = await handleChatCompletions(
			{ model: "test", messages: [{ role: "user", content: "Hi" }] } as any,
			client as any,
		);
		expect(res.status).toBe(200);
		expect(captured()?.reasoningEffort).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/reasoning-effort.test.ts`
Expected: FAIL — `captured()?.reasoningEffort` is `undefined` in test 1 (nothing forwards it yet)

- [ ] **Step 3: Implement plumbing**

In `src/providers/types.ts`, add import + extend `sendMessage` params:

```ts
import type { ReasoningEffort } from "./model-spec.ts";
```

```ts
	sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		reasoningEffort?: ReasoningEffort;
	}): Promise<ReadableStream<Uint8Array>>;
```

In `src/providers/factory/types.ts`, extend `NormalizedSendParams`:

```ts
import type { ReasoningEffort } from "../model-spec.ts";

/** Parameters passed to `callApi` / DOM hooks after default-model resolution. */
export interface NormalizedSendParams {
	message: string;
	model: string;
	signal?: AbortSignal;
	reasoningEffort?: ReasoningEffort;
}
```

In `src/providers/factory/base-api-client.ts`, extend `sendMessage` signature + normalized:

```ts
	async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		reasoningEffort?: ReasoningEffort;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const normalized: NormalizedSendParams = {
			message: params.message,
			model: params.model || this.config.defaultModel,
			signal: params.signal,
			reasoningEffort: params.reasoningEffort,
		};
```

(add `import type { ReasoningEffort } from "../model-spec.ts";` to its imports.)

In `src/providers/factory/base-dom-client.ts`, same two edits with
`model: params.model || this.config.models[0]?.id || "default"`.

In `src/openai/types.ts`, extend `ChatCompletionRequest`:

```ts
	stream?: boolean;
	reasoning_effort?: ReasoningEffort;
```

(add `import type { ReasoningEffort } from "../providers/model-spec.ts";` at top.)

In `src/openai/chat-completions.ts`, pass through at both call sites:

```ts
		const stream = await client.sendMessage({ message: prompt, model, reasoningEffort: body.reasoning_effort });
```

```ts
		providerStream = await client.sendMessage({ message: prompt, model, reasoningEffort: body.reasoning_effort });
```

In `src/providers/deepseek/client.ts`, extend the override signature only (flag logic stays until Task 3):

```ts
	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
		reasoningEffort?: ReasoningEffort;
	}): Promise<ReadableStream<Uint8Array>> {
```

(add `import type { ReasoningEffort } from "../model-spec.ts";`. Leave the body untouched —
`params.reasoningEffort` will simply be unused until Task 3; `tsc` must stay clean since all
params are optional.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/reasoning-effort.test.ts test/model-spec.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/providers/factory/types.ts src/providers/factory/base-api-client.ts src/providers/factory/base-dom-client.ts src/openai/types.ts src/openai/chat-completions.ts src/providers/deepseek/client.ts test/reasoning-effort.test.ts
git commit -m "feat: plumb reasoningEffort end to end"
```

---

### Task 3: DeepSeek flags + catalog

**Files:**
- Modify: `src/providers/deepseek/client.ts` (flag resolution)
- Modify: `src/providers/deepseek/index.ts` (published variants)
- Test: extend `test/models-refresh.test.ts`? No — new `test/deepseek-flags.test.ts`

**Interfaces:**
- Consumes: `parseModelString`, `effortToThink`, `reasoningEffort` passthrough (Tasks 1-2)
- Produces: suffixed DeepSeek ids usable via `/v1/models` + `models` CLI (no signature changes)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { resolveDeepSeekFlags } from "../src/providers/deepseek/client.ts";

describe("resolveDeepSeekFlags", () => {
	test("defaults: chat=not thinking+search, reasoner=thinking+search", () => {
		expect(resolveDeepSeekFlags("deepseek-chat", undefined)).toEqual({
			base: "deepseek-chat",
			thinking: false,
			search: true,
		});
		expect(resolveDeepSeekFlags("deepseek-reasoner", undefined)).toEqual({
			base: "deepseek-reasoner",
			thinking: true,
			search: true,
		});
	});

	test("suffixes override defaults", () => {
		expect(resolveDeepSeekFlags("deepseek-chat:think", undefined).thinking).toBe(true);
		expect(resolveDeepSeekFlags("deepseek-reasoner:no-think", undefined).thinking).toBe(false);
		expect(resolveDeepSeekFlags("deepseek-chat:search-off", undefined).search).toBe(false);
	});

	test("reasoning_effort applies when no suffix, suffix wins on conflict", () => {
		expect(resolveDeepSeekFlags("deepseek-chat", "high").thinking).toBe(true);
		expect(resolveDeepSeekFlags("deepseek-reasoner", "none").thinking).toBe(false);
		expect(resolveDeepSeekFlags("deepseek-chat:think", "none").thinking).toBe(true);
	});

	test("combined suffixes resolve together", () => {
		expect(resolveDeepSeekFlags("deepseek-chat:think:search-off", undefined)).toEqual({
			base: "deepseek-chat",
			thinking: true,
			search: false,
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/deepseek-flags.test.ts`
Expected: FAIL with "Export named 'resolveDeepSeekFlags' not found"

- [ ] **Step 3: Implement in `src/providers/deepseek/client.ts`**

Add import:

```ts
import { effortToThink, parseModelString } from "../model-spec.ts";
```

Add exported resolver (place before the `DeepSeekWebClient` class, after the `BrowserEvalStringResult` type around line 59):

```ts
export function resolveDeepSeekFlags(
	model: string | undefined,
	reasoningEffort?: ReasoningEffort,
): { base: string; thinking: boolean; search: boolean } {
	const spec = parseModelString(model || "deepseek-chat");
	const isReasoner = spec.base === "deepseek-reasoner";
	return {
		base: spec.base,
		thinking: spec.think ?? effortToThink(reasoningEffort) ?? isReasoner,
		search: spec.search ?? true,
	};
}
```

(`ReasoningEffort` type already imported in Task 2 — extend that import line to
`import { effortToThink, parseModelString } from "../model-spec.ts"; import type { ReasoningEffort } from "../model-spec.ts";`
or a single `import { effortToThink, parseModelString, type ReasoningEffort } from "../model-spec.ts";`.)

Rewire `chatCompletions` params + body (lines 292-318): add `reasoningEffort?: ReasoningEffort`
to the params object, and replace the two flag lines:

```ts
	const flags = resolveDeepSeekFlags(params.model, params.reasoningEffort);
	const requestBody = {
		chat_session_id: params.sessionId,
		parent_message_id: params.parentMessageId ?? null,
		prompt: params.message,
		ref_file_ids: params.fileIds || [],
		thinking_enabled: flags.thinking,
		search_enabled: flags.search,
		preempt: params.preempt ?? false,
	};
```

Rewire `sendMessage` (lines 119-138) to pass through:

```ts
		const body = await this.chatCompletions({
			sessionId: this.chatSessionId,
			parentMessageId: this.parentMessageId,
			message: params.message,
			model: params.model,
			signal: params.signal,
			reasoningEffort: params.reasoningEffort,
		});
```

- [ ] **Step 4: Publish variants in `src/providers/deepseek/index.ts`**

```ts
	models: [
		{ id: "deepseek-chat", name: "DeepSeek Chat" },
		{ id: "deepseek-chat:think", name: "DeepSeek Chat (thinking)" },
		{ id: "deepseek-chat:search-off", name: "DeepSeek Chat (no search)" },
		{ id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
		{ id: "deepseek-reasoner:no-think", name: "DeepSeek Reasoner (no thinking)" },
		{ id: "deepseek-reasoner:search-off", name: "DeepSeek Reasoner (no search)" },
	],
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test test/deepseek-flags.test.ts test/model-spec.test.ts test/reasoning-effort.test.ts`
Expected: PASS
Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Live verify (needs Chrome at 127.0.0.1:9222 + deepseek login; standalone script, delete after)**

Write `/tmp/probe-ds-flags.ts` (outside repo — never commit; substitute your checkout path for `<repo>`):

```ts
import { getProviderClient } from "<repo>/src/providers/registry.ts";
const client = await getProviderClient("deepseek-web");
if (!client) throw new Error("no client");
const ds = client as any;
const session = await ds.createChatSession();
const sid = session.chat_session_id;
for (const [label, model] of [["think-off", "deepseek-reasoner:no-think"], ["search-off", "deepseek-chat:search-off"]]) {
	const body = await ds.chatCompletions({ sessionId: sid, parentMessageId: null, message: "Ответь одним словом: привет", model });
	let text = "";
	const res = await client.parseStream(body, (d: string) => { text += d; });
	console.log(`${label}: text=${text.slice(0, 80)} thinkingChars=${(res.thinkingText || "").length}`);
}
await client.close?.();
process.exit(0);
```

Run: `bun /tmp/probe-ds-flags.ts`, then `rm /tmp/probe-ds-flags.ts`.
Expected: `think-off` → `thinkingChars=0`; `search-off` → normal answer, no error.
If live check cannot run (no login), note it in the report and proceed — unit tests carry the gate.

- [ ] **Step 7: Commit**

```bash
git add src/providers/deepseek/client.ts src/providers/deepseek/index.ts test/deepseek-flags.test.ts
git commit -m "feat: deepseek think/search flags via suffixes and effort"
```

---

### Task 4: GLM-intl catalog + DOM model select + Deep Think

**Files:**
- Modify: `src/providers/glm-intl/client.ts`
- Modify: `src/providers/glm-intl/index.ts`
- Test: manual live verification (DOM needs real browser; unit-cover the pure mapping)

**Interfaces:**
- Consumes: `parseModelString`, `effortToThink`, `reasoningEffort` in `NormalizedSendParams` (Tasks 1-2)
- Produces: working `glm-5.3-flash | glm-5.3 | glm-5.2` ids with `:think`/`:no-think`

Display→id mapping (verified live 2026-09-15): picker shows `GLM-5.3-Flash`, `GLM-5.3`, `GLM-5.2`;
normalize label via `toLowerCase().replace(/\s+/g, "-")` → `glm-5.3-flash`, `glm-5.3`, `glm-5.2`.

- [ ] **Step 1: Publish real catalog in `src/providers/glm-intl/index.ts`**

```ts
	models: [
		{ id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
		{ id: "glm-5.3", name: "GLM 5.3" },
		{ id: "glm-5.2", name: "GLM 5.2" },
	],
```

Also update `src/providers/glm-intl/client.ts` config `models` to the same three entries
(keep existing `pollIntervalMs: 900, maxWaitMs: 120_000, stabilityThreshold: 3`).

- [ ] **Step 2: Add `ensureModel` + think-toggle helpers and wire into `sendViaDom`**

Add imports to `src/providers/glm-intl/client.ts`:

```ts
import { effortToThink, parseModelString } from "../model-spec.ts";
```

Add these methods to `GlmIntlWebClient` (before `sendViaDom`):

```ts
	private normalizeLabel(label: string): string {
		return label.trim().toLowerCase().replace(/\s+/g, "-");
	}

	/** Ensure the site picker shows the requested model. Throws (never silent wrong-model). */
	private async ensureModel(page: Page, baseId: string): Promise<void> {
		const picker = page.getByRole("button", { name: "Select a model" });
		const current = this.normalizeLabel((await picker.textContent({ timeout: 10000 })) ?? "");
		if (current === baseId) return;
		await picker.click({ timeout: 10000 });
		await page.waitForTimeout(1500);
		const item = page.locator("[role='menu'] button", { hasText: baseId }).first();
		await item.click({ timeout: 10000 });
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

	/**
	 * Set the Deep Think toggle to `want` (true/false). `undefined` → leave untouched.
	 * Reverse-engineered live: label SPAN "Deep Think" inside a pressable ancestor.
	 */
	private async ensureThink(page: Page, want: boolean | undefined): Promise<void> {
		if (want === undefined) return;
		const toggle = page.locator(
			"xpath=//*[normalize-space(text())='Deep Think']/ancestor-or-self::*[self::button or @role='button' or @aria-pressed][1]",
		);
		if ((await toggle.count()) === 0) {
			throw new Error("glm-intl-web: Deep Think toggle not found");
		}
		const pressed = await toggle.first().getAttribute("aria-pressed");
		const cls = ((await toggle.first().getAttribute("class")) || "").toLowerCase();
		const isOn = pressed === "true" || cls.includes("active") || cls.includes("selected");
		if (isOn !== want) {
			await toggle.first().click({ timeout: 10000 });
			await page.waitForTimeout(1000);
		}
	}
```

Wire into `sendViaDom` — insert as the first statements (before the `page.url()` check):

```ts
		const spec = parseModelString(params.model);
		await this.ensureModel(page, spec.base);
		await this.ensureThink(page, spec.think ?? effortToThink(params.reasoningEffort));
```

Note: `params.model` in `NormalizedSendParams` is always set (base client defaults to
`config.models[0].id` = `glm-5.3-flash`); `parseModelString` handles plain ids too.

- [ ] **Step 3: Typecheck + existing tests**

Run: `bunx tsc --noEmit`
Expected: no errors
Run: `bun test`
Expected: all PASS (no behavior change for existing tests — GLM paths need a browser)

- [ ] **Step 4: Live verify (needs Chrome + glm-intl login; restore user's picker afterwards)**

Write `/tmp/probe-glm.ts` (outside repo; substitute your checkout path for `<repo>`):

```ts
import { getProviderClient } from "<repo>/src/providers/registry.ts";
const client = await getProviderClient("glm-intl-web");
if (!client) throw new Error("no client");
for (const model of ["glm-5.2", "glm-5.3"]) {
	const t0 = Date.now();
	const stream = await client.sendMessage({ message: "Ответь одним словом: привет", model });
	let text = "";
	await client.parseStream(stream, (d: string) => { text += d; });
	console.log(`${model} (${Date.now() - t0}ms): ${text.slice(0, 120)}`);
}
// restore the default the user had
await client.sendMessage({ message: "Ответь одним словом: пока", model: "glm-5.3-flash" });
await client.close?.();
process.exit(0);
```

Run: `bun /tmp/probe-glm.ts`, then `rm /tmp/probe-glm.ts`.
Expected: both models answer; no "failed to select model" error. If the Deep Think
toggle locator fails (`Deep Think toggle not found`), inspect the live DOM
(`closest('button')` chain from the SPAN) and fix the XPath — one iteration allowed,
keep it minimal.
If live check cannot run (no login), note it in the report and proceed.

- [ ] **Step 5: Commit**

```bash
git add src/providers/glm-intl/client.ts src/providers/glm-intl/index.ts
git commit -m "feat: glm-intl real models, DOM select, deep think toggle"
```

---

### Task 5: Suffix-aware routing + full verification

**Files:**
- Modify: `src/providers/registry.ts` (`resolveModelToProvider`)
- Test: `test/model-routing.test.ts`

**Interfaces:**
- Consumes: `parseModelString` (Task 1); suffixed catalog ids (Tasks 3-4)
- Produces: `deepseek-reasoner:search-off` etc. routable to the right provider client

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/model-routing.test.ts`
Expected: FAIL — suffixed ids return `null` (registry matches full strings only)

- [ ] **Step 3: Strip suffixes in `resolveModelToProvider` (`src/providers/registry.ts`)**

Replace the direct-match loop:

```ts
	// Search all providers for matching model ID (suffixes stripped: "base:flag" → "base")
	for (const def of defs) {
		if (def.models.some((m) => m.id === model || m.id === model.split(":")[0])) return def.id;
	}
```

(Keep the prefixed `provider/model` branch above it untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/model-routing.test.ts`
Expected: PASS

- [ ] **Step 5: Full verification**

Run: `bun test`
Expected: all suites PASS
Run: `bunx tsc --noEmit`
Expected: no errors
Run: `bunx @biomejs/biome check src/providers/model-spec.ts src/providers/deepseek/client.ts src/providers/deepseek/index.ts src/providers/glm-intl/client.ts src/providers/glm-intl/index.ts src/providers/registry.ts src/providers/types.ts src/providers/factory/types.ts src/providers/factory/base-api-client.ts src/providers/factory/base-dom-client.ts src/openai/types.ts src/openai/chat-completions.ts test/model-spec.test.ts test/reasoning-effort.test.ts test/deepseek-flags.test.ts test/model-routing.test.ts`
Expected: no NEW errors (repo has pre-existing CRLF format drift — untouched files fail identically; only fix issues inside lines this branch changed)
Run: `bun index.ts models`
Expected: lists new ids incl. `deepseek-chat:think`, `glm-5.3`, etc. (for authorized providers)

- [ ] **Step 6: Commit**

```bash
git add src/providers/registry.ts test/model-routing.test.ts
git commit -m "feat: route suffixed model ids by base"
```
