# DeepSeek ↔ OpenCode Chat Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every OpenCode/Hermes chat to a distinct, persistent DeepSeek browser conversation automatically.

**Architecture:** A project OpenCode plugin adds its stable `sessionID` as `X-TFG-Conversation-ID` for the gateway providers. The gateway forwards that key as an optional `conversationId` through the provider contract; DeepSeek alone uses it to select a client-owned page and persists its URL beside the existing auth store.

**Tech Stack:** Bun, TypeScript, Playwright-core, node:fs, Bun test.

**Spec:** `docs/superpowers/specs/2026-09-19-deepseek-opencode-chat-routing-design.md`

## Global Constraints

- Keep the gateway on port `3456`.
- Do not select, alter, or close user-owned DeepSeek tabs.
- Do not identify chats from prompt text or message-history heuristics.
- Do not add dependencies.
- Persist only opaque gateway/OpenCode conversation keys and DeepSeek conversation URLs; never persist prompts or replies.

## Review Focus

- Missing, whitespace-only, or absent session keys return a clear `400`, tested in Task 1.
- A client restart restores the saved DeepSeek URL in a newly created service tab, tested in Task 3.
- Two keys never share a page or queue, tested in Task 3.
- A corrupt route-store file recovers as an empty store without breaking the gateway, tested in Task 2.
- A browser-client preflight includes the session-key header, tested in Task 1.

---

## File Structure

- `.opencode/plugins/deepseek-chat-routing.ts` — project OpenCode hook that forwards `sessionID` to the gateway.
- `src/openai/conversation-key.ts` — validate `X-TFG-Conversation-ID`.
- `src/openai/types.ts`, `src/openai/chat-completions.ts`, `src/server.ts` — carry identity from HTTP request to provider.
- `src/providers/types.ts`, `src/providers/factory/{types,base-dom-client}.ts` — carry optional `conversationId` through existing clients.
- `src/providers/deepseek/chat-routes.ts` — opaque key → DeepSeek URL persistence.
- `src/providers/deepseek/client.ts` — client-owned page and queue per key.
- `test/deepseek-chat-routes.test.ts`, `test/chat-completions.test.ts`, `test/deepseek-flags.test.ts` — regression coverage.

### Task 1: Forward OpenCode's explicit chat key

**Files:**
- Create: `.opencode/plugins/deepseek-chat-routing.ts`, `src/openai/conversation-key.ts`
- Modify: `src/openai/types.ts`, `src/openai/chat-completions.ts`, `src/server.ts`, `src/providers/types.ts`, `src/providers/factory/types.ts`, `src/providers/factory/base-dom-client.ts`, `test/chat-completions.test.ts`

**Interfaces:**
- Produces: `resolveConversationKey(request: Request, body: ChatCompletionRequest): string | null`.
- Produces: optional `conversationId?: string` on provider send parameters.
- Consumes: Task 3 consumes `NormalizedSendParams.conversationId`.

- [ ] **Step 1: Install the project OpenCode session-header plugin**

OpenCode's typed `chat.headers` hook receives `input.sessionID`. Create this global plugin so only the configured gateway providers send the identity:

```ts
export const DeepSeekChatRouting = async () => ({
  "chat.headers": async (input, output) => {
    if (!["pricol", "prikol1"].includes(input.provider.id)) return;
    output.headers["X-TFG-Conversation-ID"] = input.sessionID;
  },
});
```

- [ ] **Step 2: Write failing key-resolution and forwarding tests**

Add tests for the `X-TFG-Conversation-ID` header. The resolver trims values and returns `null` for missing or whitespace-only values. Add a handler test using a provider double that records `conversationId`.

```ts
expect(resolveConversationKey(requestWithKey, body)).toBe("chat-a");
expect(resolveConversationKey(requestWithoutKey, body)).toBeNull();
expect(provider.sendParams.conversationId).toBe("chat-a");
```

Run: `bun test test/chat-completions.test.ts`

Expected: FAIL because no key resolver or provider parameter exists.

- [ ] **Step 3: Implement the smallest explicit-key path**

Create a resolver that reads `X-TFG-Conversation-ID`, returns `null` for invalid values, and never reads `messages`. Extend request/provider types and forward the value without changing prompt construction. Add that header to `Access-Control-Allow-Headers`.

```ts
const conversationId = resolveConversationKey(req, body);
return handleChatCompletions(body, provider, { conversationId });
```

DeepSeek with no identity returns:

```ts
jsonError("DeepSeek routing requires an OpenCode/Hermes chat identifier", 400);
```

Other providers still accept a missing key.

- [ ] **Step 4: Verify Task 1**

Run: `bun test test/chat-completions.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/openai/conversation-key.ts src/openai/types.ts src/openai/chat-completions.ts src/server.ts src/providers/types.ts src/providers/factory/types.ts src/providers/factory/base-dom-client.ts test/chat-completions.test.ts
git commit -m "feat: forward OpenCode chat identity"
```

### Task 2: Persist opaque DeepSeek chat routes

**Files:**
- Create: `src/providers/deepseek/chat-routes.ts`, `test/deepseek-chat-routes.test.ts`

**Interfaces:**
- Produces: `getDeepSeekChatRoute(key: string): string | null`.
- Produces: `setDeepSeekChatRoute(key: string, url: string): void`.
- Consumes: Task 3 uses both functions.

- [ ] **Step 1: Write failing persistence tests**

Use `TFG_STORE_PATH` for an isolated directory. Test a missing file, a round trip, and invalid JSON recovery.

```ts
setDeepSeekChatRoute("chat-a", "https://chat.deepseek.com/a/chat/s/a");
expect(getDeepSeekChatRoute("chat-a")).toBe("https://chat.deepseek.com/a/chat/s/a");
writeFileSync(getDeepSeekChatRoutesPath(), "not json");
expect(getDeepSeekChatRoute("chat-a")).toBeNull();
```

Run: `bun test test/deepseek-chat-routes.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the route store**

Place `deepseek-chat-routes.json` beside `auth-profiles.json`, using the synchronous `node:fs` pattern from `model-cache.ts`. Store only:

```ts
type DeepSeekChatRoutes = Record<string, { url: string; updatedAt: string }>;
```

Return an empty store after read or JSON errors. Reject blank keys and URLs outside `https://chat.deepseek.com/` before saving.

- [ ] **Step 3: Verify Task 2**

Run: `bun test test/deepseek-chat-routes.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit Task 2**

```bash
git add src/providers/deepseek/chat-routes.ts test/deepseek-chat-routes.test.ts
git commit -m "feat: persist DeepSeek chat routes"
```

### Task 3: Route DeepSeek requests to client-owned per-chat pages

**Files:**
- Modify: `src/providers/deepseek/client.ts`, `test/deepseek-flags.test.ts`

**Interfaces:**
- Consumes: `NormalizedSendParams.conversationId`, `getDeepSeekChatRoute`, `setDeepSeekChatRoute`.
- Produces: one client-owned `Page` and one serial queue per key.

- [ ] **Step 1: Write failing per-chat page tests**

Use a `BrowserManager.getContext().newPage()` double. Assert that `chat-a` and `chat-b` create separate pages, repeated `chat-a` reuses its page, no user page is touched, and a new client instance navigates to the saved `chat-a` URL.

```ts
expect(newPageCalls).toBe(2);
expect(gotos).toEqual([
  "https://chat.deepseek.com/",
  "https://chat.deepseek.com/",
  "https://chat.deepseek.com/a/chat/s/a",
]);
```

Add a queue assertion: a pending `chat-a` response does not delay `chat-b`.

Run: `bun test test/deepseek-flags.test.ts`

Expected: FAIL because the client has one global page and queue.

- [ ] **Step 2: Implement per-key pages and queues**

Replace the single DeepSeek `page` and `tail` fields with `Map<string, Page>` and `Map<string, Promise<void>>`. Require `conversationId` before selecting a page. Create pages only through `BrowserManager.getContext().newPage()`; navigate to a saved route or `https://chat.deepseek.com/`.

After a settled response, persist `page.url()` only when it is a DeepSeek conversation URL. `close()` closes every mapped page. Keep the existing input, `Continue`, and settled-response loop unchanged.

```ts
const page = await this.getPageForConversation(params.conversationId);
const stream = await super.sendMessage(params);
setDeepSeekChatRoute(params.conversationId, page.url());
return stream;
```

- [ ] **Step 3: Verify Task 3**

Run: `bun test test/deepseek-flags.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit Task 3**

```bash
git add src/providers/deepseek/client.ts test/deepseek-flags.test.ts
git commit -m "feat: route DeepSeek chats by OpenCode session"
```

### Task 4: Verify automatic routing against OpenCode/Hermes

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: one concise identity-contract note.

- [ ] **Step 1: Exercise the live sequence**

With gateway on `3456`, send these prompts through OpenCode/Hermes:

```text
Chat A: "Reply exactly A-one"
Chat B: "Reply exactly B-one"
Return to Chat A: "Reply exactly A-two"
```

Confirm A and B use distinct service pages, returning to A uses its original page, and ordinary DeepSeek tabs are unchanged.

- [ ] **Step 2: Document the identity contract**

Add a README note naming `X-TFG-Conversation-ID`, added automatically by the global OpenCode plugin, and explain that `deepseek-chat-routes.json` contains only opaque IDs and DeepSeek URLs.

- [ ] **Step 3: Run full verification**

Run: `bun test && bun run typecheck && bun run lint && git diff --check`

Expected: PASS.

- [ ] **Step 4: Commit Task 4**

```bash
git add README.md
git commit -m "docs: explain DeepSeek chat routing"
```

## Self-Review

- Spec coverage: Tasks 1–3 implement explicit identity, persistence, page restoration, isolation, and per-key concurrency; Task 4 proves the user-visible flow and documents it.
- Placeholder scan: no inferred identity mechanism appears; Task 1 has a defined observable acceptance condition.
- Type consistency: `conversationId` stays optional in generic clients and is required only by DeepSeek page routing.
- Review focus: every listed condition has a named test in Tasks 1–3.
