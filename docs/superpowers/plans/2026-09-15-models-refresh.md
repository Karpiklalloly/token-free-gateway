# Models Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add model-list refresh: file cache, background refresh on startup, `POST /v1/models/refresh`, and `models` CLI.

**Architecture:** `src/providers/model-cache.ts` persists per-provider model lists to `models-cache.json`; `registry.refreshModels()` updates it via a new optional `fetchModels()` client hook (defaults to static); server and CLI read/trigger it.

**Tech Stack:** Bun, TypeScript, `bun:test`, existing provider registry.

## Global Constraints

- Bun instead of Node.js: `bun test`, `bun index.ts`, `bunx <package>`.
- Test override env: `TFG_STORE_PATH` (existing), new `TFG_MODELS_CACHE_PATH` (isolates tests).
- Per-provider refresh timeout: 15000 ms.
- One provider failing never fails the whole refresh.
- No real `fetchModels()` provider overrides in this plan (deferred).

---

### Task 1: Model cache module

**Files:**
- Create: `src/providers/model-cache.ts`
- Test: `test/model-cache.test.ts`

**Interfaces:**
- Consumes: `ModelInfo` from `src/providers/types.ts`
- Produces: `getModelsCachePath()`, `loadModelsCache()`, `saveModelsCache()`, `getCachedModels()`, `setCachedModels()` for Task 3

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/model-cache.test.ts`
Expected: FAIL with "Cannot find module" (file does not exist yet)

- [ ] **Step 3: Write minimal implementation**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelInfo } from "./types.ts";

export interface CachedProviderModels {
	models: ModelInfo[];
	updatedAt: string;
}

export type ModelsCache = Record<string, CachedProviderModels>;

/** Cache path. Explicit override wins; otherwise sits next to the auth store. */
export function getModelsCachePath(): string {
	if (process.env.TFG_MODELS_CACHE_PATH) return process.env.TFG_MODELS_CACHE_PATH;
	const storePath =
		process.env.TFG_STORE_PATH ?? join(homedir(), ".token-free-gateway", "auth-profiles.json");
	return join(dirname(storePath), "models-cache.json");
}

export function loadModelsCache(): ModelsCache {
	try {
		const p = getModelsCachePath();
		if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")) as ModelsCache;
	} catch (e) {
		console.warn(`[model-cache] Failed to load: ${e}`);
	}
	return {};
}

export function saveModelsCache(cache: ModelsCache): void {
	const p = getModelsCachePath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8");
}

export function getCachedModels(providerId: string): ModelInfo[] | null {
	return loadModelsCache()[providerId]?.models ?? null;
}

export function setCachedModels(providerId: string, models: ModelInfo[]): void {
	const cache = loadModelsCache();
	cache[providerId] = { models, updatedAt: new Date().toISOString() };
	saveModelsCache(cache);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/model-cache.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/providers/model-cache.ts test/model-cache.test.ts
git commit -m "feat: add models cache module"
```

---

### Task 2: `fetchModels()` hook with static default

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/factory/base-api-client.ts`
- Modify: `src/providers/factory/base-dom-client.ts`
- Test: `test/fetch-models.test.ts`

**Interfaces:**
- Consumes: `ModelInfo` (same file), `ApiClientConfig` / `DomClientConfig` (unchanged)
- Produces: `WebProviderClient.fetchModels?()` used by Task 3

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fetch-models.test.ts`
Expected: FAIL with "`fetchModels` does not exist" (type error at runtime: `c.fetchModels is not a function`)

- [ ] **Step 3: Add optional hook to `WebProviderClient` in `src/providers/types.ts`**

Replace the `listModels` line block:

```ts
	listModels(): ModelInfo[];
	/**
	 * Live model discovery. Optional: defaults to `listModels()` (static catalog)
	 * until a provider implements a real override. Used by `refreshModels()`.
	 */
	fetchModels?(): Promise<ModelInfo[]>;
```

- [ ] **Step 4: Add default to `src/providers/factory/base-api-client.ts`**

Insert after the existing `listModels()` method (lines 113-115):

```ts
	fetchModels(): Promise<ModelInfo[]> {
		return Promise.resolve(this.config.models);
	}
```

- [ ] **Step 5: Add default to `src/providers/factory/base-dom-client.ts`**

Insert after the existing `listModels()` method (lines 91-93):

```ts
	fetchModels(): Promise<ModelInfo[]> {
		return Promise.resolve(this.config.models);
	}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/fetch-models.test.ts test/model-cache.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/types.ts src/providers/factory/base-api-client.ts src/providers/factory/base-dom-client.ts test/fetch-models.test.ts
git commit -m "feat: add fetchModels hook with static default"
```

---

### Task 3: Registry — cache-aware listing plus `refreshModels()`

**Files:**
- Modify: `src/providers/registry.ts`
- Test: `test/models-refresh.test.ts`

**Interfaces:**
- Consumes: `getCachedModels`, `setCachedModels` (Task 1); `fetchModels?()` (Task 2); `getCredentials`, `listAuthorizedProviders` (existing)
- Produces: `refreshModels(providerId?)`, `RefreshModelsReport`, cache-aware `listAllModels()` for Tasks 4-5

- [ ] **Step 1: Write the failing tests**

```ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/models-refresh.test.ts`
Expected: FAIL with "`refreshModels` does not exist" (import error)

- [ ] **Step 3: Implement in `src/providers/registry.ts`**

Add import at top (extend existing `./auth-store.ts` import and add model-cache import):

```ts
import { getCredentials, listAuthorizedProviders } from "./auth-store.ts";
import { getCachedModels, setCachedModels } from "./model-cache.ts";
```

(note: current file imports only `getCredentials` on line 6 — extend that line, add the model-cache line after it.)

Replace `listAllModels()` body (lines 133-142) with:

```ts
export async function listAllModels(): Promise<ModelInfo[]> {
	const defs = await loadDefinitions();
	const models: ModelInfo[] = [];
	for (const def of defs) {
		const creds = getCredentials(def.id);
		if (!creds) continue;
		models.push(...(getCachedModels(def.id) ?? def.models));
	}
	return models;
}
```

Append at end of file:

```ts
export interface RefreshModelsReport {
	refreshed: string[];
	failed: { provider: string; reason: string }[];
	models: number;
}

const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh the cached model list for authorized providers.
 * Best-effort per provider: one failure never fails the whole report.
 * Providers without a live `fetchModels()` override fall back to static.
 */
export async function refreshModels(providerId?: string): Promise<RefreshModelsReport> {
	const defs = await loadDefinitions();
	const authorized = new Set(listAuthorizedProviders());
	const targets = defs.filter(
		(d) => authorized.has(d.id) && (!providerId || d.id === providerId),
	);
	const report: RefreshModelsReport = { refreshed: [], failed: [], models: 0 };
	if (providerId && targets.length === 0) {
		report.failed.push({ provider: providerId, reason: "not authorized" });
		return report;
	}
	await Promise.all(
		targets.map(async (def) => {
			try {
				const client = await getProviderClient(def.id);
				if (!client) throw new Error("no credentials");
				const live =
					(await Promise.race([
						client.fetchModels?.() ?? client.listModels(),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("refresh timed out")), REFRESH_TIMEOUT_MS),
						),
					])) ?? def.models;
				setCachedModels(def.id, live);
				report.refreshed.push(def.id);
			} catch (err) {
				report.failed.push({
					provider: def.id,
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		}),
	);
	report.models = (await listAllModels()).length;
	return report;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/models-refresh.test.ts test/model-cache.test.ts test/fetch-models.test.ts`
Expected: PASS (note: first two refreshModels tests need no browser; the cache-preference test never inits a client)

- [ ] **Step 5: Commit**

```bash
git add src/providers/registry.ts test/models-refresh.test.ts
git commit -m "feat: cache-aware listAllModels and refreshModels"
```

---

### Task 4: Server — startup refresh plus `POST /v1/models/refresh`

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `refreshModels()` (Task 3)
- Produces: `POST /v1/models/refresh` for Task 5

- [ ] **Step 1: Extend the registry import in `src/server.ts` (lines 6-11)**

```ts
import {
	checkAllSessions,
	getClientForModel,
	listAllModels,
	refreshModels,
	resolveModelToProvider,
} from "./providers/registry.ts";
```

- [ ] **Step 2: Add the refresh route before the `/v1/models/` prefix block (after lines 53-55)**

```ts
	if (pathname === "/v1/models/refresh" && req.method === "POST") {
		return withCors(await handleRefreshModelsRoute());
	}
```

- [ ] **Step 3: Add the handler after `handleModelsRoute()` (after line 131)**

```ts
async function handleRefreshModelsRoute(): Promise<Response> {
	const report = await refreshModels();
	return Response.json({ ...report, models: (await listAllModels()).length });
}
```
(note: `refreshModels()` already sets `models`, the extra recount keeps the response truthful if cache changed mid-flight.)

- [ ] **Step 4: Trigger best-effort background refresh on startup**

Insert after the "Authorized providers" `console.log` block (lines 163-166), before `gracefulShutdown`:

```ts
refreshModels()
	.then((report) => {
		console.log(
			`[models] Startup refresh: ${report.refreshed.length} ok, ${report.failed.length} failed, ${report.models} models`,
		);
	})
	.catch((err) => {
		console.warn(`[models] Startup refresh failed: ${err instanceof Error ? err.message : String(err)}`);
	});
```

- [ ] **Step 5: Verify manually (no Chrome needed; refresh degrades to `failed` entries)**

Run (PowerShell): `$env:TFG_PORT="3457"; $srv = Start-Process bun -ArgumentList "index.ts","serve" -PassThru; Start-Sleep 3; (Invoke-RestMethod http://localhost:3457/v1/models | ConvertTo-Json -Depth 3).Substring(0,300); Invoke-RestMethod -Method Post http://localhost:3457/v1/models/refresh | ConvertTo-Json; Stop-Process -Id $srv.Id; Remove-Item Env:TFG_PORT`
Expected: `GET` returns `{"object":"list","data":[...]}`; `POST` returns JSON with `refreshed` and `failed` arrays

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: refresh models on startup and POST /v1/models/refresh"
```

---

### Task 5: CLI `models` command

**Files:**
- Create: `src/cli/models.ts`
- Modify: `index.ts`
- Test: manual (standalone mode needs no daemon)

**Interfaces:**
- Consumes: `GET /v1/models`, `POST /v1/models/refresh` (Task 4); `listAllModels`, `refreshModels`, `resolveModelToProvider` (Task 3)

- [ ] **Step 1: Create `src/cli/models.ts`**

```ts
import { loadConfig } from "../config.ts";
import {
	listAllModels,
	refreshModels,
	resolveModelToProvider,
} from "../providers/registry.ts";

function daemonBaseUrl(): string {
	return `http://localhost:${loadConfig().port}`;
}

async function tryDaemon(path: string, method: string): Promise<unknown | null> {
	try {
		const headers: Record<string, string> = {};
		if (loadConfig().gatewayApiKey) headers.Authorization = `Bearer ${loadConfig().gatewayApiKey}`;
		const res = await fetch(`${daemonBaseUrl()}${path}`, {
			method,
			headers,
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		return (await res.json()) as unknown;
	} catch {
		return null;
	}
}

/**
 * `models [provider] [--refresh] [--json]`
 * Daemon running → HTTP; otherwise standalone registry calls.
 */
export async function modelsCommand(rawArgs: string[]): Promise<void> {
	const wantRefresh = rawArgs.includes("--refresh");
	const asJson = rawArgs.includes("--json");
	const provider = rawArgs.find((a) => !a.startsWith("--"));

	if (wantRefresh) {
		const via = provider
			? null
			: await tryDaemon("/v1/models/refresh", "POST");
		const report = via ?? (await refreshModels(provider));
		if (asJson) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			const r = report as { refreshed: string[]; failed: { provider: string; reason: string }[]; models: number };
			console.log(`Refreshed: ${r.refreshed.length > 0 ? r.refreshed.join(", ") : "none"}`);
			for (const f of r.failed) console.log(`  ✗ ${f.provider}: ${f.reason}`);
			console.log(`Models: ${r.models}`);
		}
		if ((report as { refreshed: string[] }).refreshed.length === 0) process.exit(1);
		return;
	}

	const viaGet = await tryDaemon("/v1/models", "GET");
	let rows: { id: string; owned_by: string }[];
	if (viaGet && typeof viaGet === "object" && Array.isArray((viaGet as { data: unknown }).data)) {
		rows = (viaGet as { data: { id: string; owned_by: string }[] }).data;
	} else {
		const models = await listAllModels();
		rows = await Promise.all(
			models.map(async (m) => ({
				id: m.id,
				owned_by: (await resolveModelToProvider(m.id)) ?? "web-provider",
			})),
		);
	}
	const filtered = provider ? rows.filter((r) => r.owned_by === provider || r.id === provider) : rows;
	if (asJson) {
		console.log(JSON.stringify({ object: "list", data: filtered }, null, 2));
	} else if (filtered.length === 0) {
		console.log("No models. Run 'token-free-gateway webauth' to authorize providers.");
	} else {
		for (const r of filtered) console.log(`${r.id}  (${r.owned_by})`);
	}
}
```

- [ ] **Step 2: Wire into `index.ts`**

Add to the help Commands block (after line 22 `chrome ...`):

```
   models [provider] [--refresh] [--json] Show/refresh models of authorized providers
```

Add branch before the `!command || serve` branch (after the `status` block, lines 65-67):

```ts
} else if (command === "models") {
	const { modelsCommand } = await import("./src/cli/models.ts");
	await modelsCommand(args.slice(1));
}
```

- [ ] **Step 3: Verify standalone listing (isolated store, no daemon)**

Run: `$env:TFG_STORE_PATH="$env:TEMP/tfg-probe.json"; $env:TFG_MODELS_CACHE_PATH="$env:TEMP/tfg-probe-m.json"; bun index.ts models`
Expected: `No models. Run 'token-free-gateway webauth' to authorize providers.`

- [ ] **Step 4: Verify `--help` mentions the command**

Run: `bun index.ts --help | grep -A1 models`
Expected: a `models [provider] ...` line

- [ ] **Step 5: Commit**

```bash
git add src/cli/models.ts index.ts
git commit -m "feat: add models CLI command"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `bun test`
Expected: all suites PASS (including `model-cache`, `fetch-models`, `models-refresh`)

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run lint**

Run: `bunx @biomejs/biome check src/providers/model-cache.ts src/providers/registry.ts src/providers/types.ts src/providers/factory/base-api-client.ts src/providers/factory/base-dom-client.ts src/server.ts src/cli/models.ts index.ts test/model-cache.test.ts test/fetch-models.test.ts test/models-refresh.test.ts`
Expected: no errors (fix with `--write` on those files only if needed, then re-run)

- [ ] **Step 4: Final commit if fixes were needed**

```bash
git add -A
git commit -m "chore: fix verification issues for models refresh"
```
(Only if Step 1-3 required changes; otherwise skip — no empty commit.)
