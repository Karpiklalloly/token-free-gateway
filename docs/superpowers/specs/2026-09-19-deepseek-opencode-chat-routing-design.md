# DeepSeek ↔ OpenCode Chat Routing Design

## Goal

Give every OpenCode/Hermes chat its own DeepSeek conversation automatically.  Returning to an earlier OpenCode/Hermes chat must return to its matching DeepSeek conversation, including after a gateway restart.

## Constraints

- Keep the gateway on port `3456`.
- Do not select, alter, or close user-owned DeepSeek tabs.
- Do not identify chats from prompt text or message-history heuristics.
- Do not add dependencies.
- Persist only opaque gateway/OpenCode conversation keys and DeepSeek conversation URLs; never persist prompts or replies.

## Identity Contract

The gateway needs a stable, per-chat opaque key from OpenCode/Hermes.  A new key means a new DeepSeek chat; the same key means the existing DeepSeek chat.

The first implementation step is a read-only capture of a real OpenCode/Hermes request.  It must establish which request field supplies that key.  The gateway will accept an explicit session identity only; it will not infer one from content.  If the client does not send a stable per-chat key, the required next change is an OpenCode/Hermes adapter configuration or integration that sends one automatically with every request.

## Architecture

`handleChatCompletions` extracts the conversation key and passes it through the provider interface.  Other providers ignore it.  `DeepSeekWebClient` replaces its one `page` field with a small key-to-page map, creating only client-owned pages from the shared browser context.

The persistent `deepseek-chat-routes.json` store, located next to the existing auth store, maps each opaque key to the final DeepSeek chat URL and update timestamp.  It contains no chat text.  At startup the map is lazy-loaded.  On a page miss or after a restart, the client opens a new client-owned page and navigates to the saved URL.  On a new key, it opens `https://chat.deepseek.com/`; DeepSeek creates the new chat when the first prompt is submitted.

## Request Flow

1. OpenCode/Hermes sends a completion request with its stable chat key.
2. The gateway resolves that key to a DeepSeek page or creates a new client-owned page.
3. It sends the request, automatically presses `Continue` when required, and waits for a settled answer.
4. After DeepSeek navigates to its conversation URL, the gateway persists the URL for that key.
5. A later request carrying the same key reuses that page, or restores its saved URL in a new client-owned page.

## Failure Rules

- Missing session identity returns a descriptive `400`; it never silently merges chats.
- A missing, closed, or navigated-away service page is recreated from the saved URL.
- Persistence failures are logged and return an error rather than claiming durable routing succeeded.
- Concurrent requests for one key are serialized.  Requests for different keys may use different client-owned pages.

## Tests

- Unit tests for loading, saving, and corrupt-store recovery.
- Route test: the OpenCode/Hermes identity reaches the provider.
- DOM tests: a new key opens a new page; the same key reuses one; a saved URL restores after an in-memory client reset.
- Regression test: a missing key is rejected, not mapped from prompt text.

## Out of Scope

- Image uploads.
- Any interaction with a user-owned DeepSeek tab.
- Guessing a chat identity from message content.
