# Provider options (DeepSeek + GLM-intl) — Design (2026-09-15)

## Context
- `fetchModels()` infra merged (models cache + `models` CLI). All providers still static.
- Goal: per-request site options — model pick, thinking on/off + effort, toggles
  (DeepSeek DeepThink/Search) — for DeepSeek Web (API) and GLM-intl (chat.z.ai, DOM).
- Live recon (2026-09-15, user Chrome via CDP, probes deleted after):
  - DeepSeek `POST /api/v0/chat/completion` sends NO model id, only
    `thinking_enabled` + `search_enabled`. "Model" is virtual → suffix mapping fits.
    `search_enabled: false` accepted by site (verified request goes through).
  - chat.z.ai offers GLM-5.3-Flash / GLM-5.3 / GLM-5.2 (static catalog `glm-4-*`
    is stale). Picker = `Select a model` button → `role=menu`; click switch verified
    round-trip, selection restored. `localStorage.selectedModels = ["glm-5.3"]`
    mirrors selection. Toggles "Deep Think" / "Max" present as SPANs (clickable
    ancestor TBD in implementation).

## Architecture
- New `src/providers/model-spec.ts`: `parseModelString(model)` →
  `{ base: string; think?: boolean; search?: boolean }`. Suffixes after `:`:
  `think | no-think | search | search-off`. Unknown suffix → `ProviderApiError(400)`
  listing valid suffixes (fail fast, never silent-ignore).
- `ChatCompletionRequest.reasoning_effort?: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"`.
  `sendMessage` / `NormalizedSendParams` gain optional `reasoningEffort`; both base
  clients forward it; `handleChatCompletions` passes `body.reasoning_effort` through.
  This is what OpenCode variant dropdown sends via AI SDK for OpenAI-compatible providers.
- `resolveModelToProvider` strips suffixes (resolve by base). Follow-up already noted:
  it is also cache-unaware — fixed separately, not here.
- Catalogs publish only sensible combos; parser accepts any valid combo for power users.

## Components
1. **model-spec.ts** — pure parser + `effortToThink(effort): boolean | undefined`
   (`none|minimal → false`, `low|medium|high|xhigh → true`, `undefined → undefined`).
   Unit-tested, no browser.
2. **DeepSeek** (`deepseek/client.ts` + `index.ts`): resolve
   `thinking = suffix.think ?? effortToThink(reasoningEffort) ?? (base === "deepseek-reasoner")`,
   `search = suffix.search ?? true`; replace current derivation
   (`client.ts:315-316`). Suffix wins over `reasoning_effort` (explicit beats ambient).
   Publish: `deepseek-chat`, `deepseek-chat:think`, `deepseek-chat:search-off`,
   `deepseek-reasoner`, `deepseek-reasoner:no-think`, `deepseek-reasoner:search-off`.
   Defaults unchanged (search on, thinking by model) — zero behavior change without suffixes.
3. **GLM-intl** (`glm-intl/client.ts` + `index.ts`): catalog →
   `glm-5.3-flash`, `glm-5.3`, `glm-5.2` (+ `:think`/`:no-think` suffixes accepted via parser).
   `ensureModel(page, baseId)`: read picker label; on mismatch click picker → menu item
   (exact-text match, not substring) → verify label changed; fallback: set
   `localStorage.selectedModels` + reload. Deep Think toggle: reverse clickable control
   in implementation; `think = suffix.think ?? effortToThink(reasoningEffort) ?? leave-as-is`
   (default: don't touch UI when neither given). Concurrent different-model requests =
   last-write-wins on shared tab (ponytail: single-user gateway, document, don't serialize).
4. **chat-completions.ts** — pass `reasoningEffort: body.reasoning_effort` in both
   `sendMessage` calls (streaming + non-streaming).

## Data flow
- OpenCode panel lists published ids from `/v1/models` → user picks
  e.g. `deepseek-reasoner:search-off` → gateway parses → site flags set.
- Variant dropdown sends `reasoning_effort` with any model id → mapped to think on/off
  (binary on both providers: any effort ≥ low = on).

## Error handling
- Unknown base id → existing 404 path untouched.
- Unknown suffix → 400 `ProviderApiError` with valid suffixes (mirrored to HTTP by existing mapping).
- GLM `ensureModel` failure (picker missing, label never changes, timeout 10 s) →
  throw 502 with provider context; do NOT send message to wrong model silently.

## Testing
- `bun test`: parser table test (valid combos, unknown suffix throws, base-only passthrough);
  effort mapping test; DeepSeek flag-resolution test (suffix > effort > default).
- Live (needs Chrome + logins, manual): `models --refresh`, one chat call per published
  DeepSeek variant (check thinking presence/absence), GLM model switch + think toggle via DOM.
- `bunx tsc --noEmit` clean.

## Out of scope
- Real `fetchModels()` live discovery per provider (separate track).
- Other 11 providers; `glm` (chatglm.cn) untouched.
- `resolveModelToProvider` cache-awareness (filed follow-up).
- Serializing concurrent per-model GLM requests.
