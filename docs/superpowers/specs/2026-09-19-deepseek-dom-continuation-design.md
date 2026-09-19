# DeepSeek DOM Continuation Design

## Goal

Make the DeepSeek provider return a completed answer to OpenCode without manual interaction.  When DeepSeek presents `Continue`, the gateway must press the button for the same request and keep waiting for its answer.

## Constraints

- Keep the gateway and OpenCode on the standard port `3456`.
- Never use or alter a user's existing DeepSeek tabs.
- Do not return an empty completion.
- Do not add dependencies.
- Image support is out of scope.

## Problem

The current client creates a DeepSeek chat through raw API calls.  A visible `Continue` control belongs to a browser-rendered chat, not necessarily to that API session.  Clicking it cannot reliably resume the API response that OpenCode is waiting for.

## Architecture

`DeepSeekWebClient` will use one client-owned browser tab rather than raw completion requests.  It will create that tab from the shared CDP browser context and keep it separate from the tabs found by `BrowserManager.getPage()`.

Requests are serialized with a small in-process promise queue because one tab cannot safely hold two simultaneous conversations.  The queue is released on both success and failure.

## Request Flow

1. Open or reuse the dedicated tab at `https://chat.deepseek.com/`.
2. Record the count of assistant messages (`.ds-message`) before sending.
3. Paste the prompt into `textarea[placeholder="Message DeepSeek"]` and submit it.
4. Wait for the new assistant message.
5. Poll the new message's rendered answer text until it is stable.
6. If the dedicated tab exposes a visible `Continue` button, click it and resume polling the same message.
7. Return the non-empty final text as the existing OpenAI-compatible response.

The only tab that can be clicked is the client-owned tab.  A user tab is never selected or modified.

## Completion and Failure Rules

- A response is complete when its extracted text is non-empty and stable for two polls while no `Continue` control is visible.
- While a visible `Continue` control exists, the provider clicks it and resets the stability counter.
- Respect the request abort signal and the existing route timeout.
- If no new response appears, or the response does not settle before the timeout, throw a descriptive provider error.  Do not fabricate or emit an empty answer.

## Tests

- Unit test that a dedicated page is created instead of reusing a user page.
- Unit test that concurrent sends are serialized.
- DOM-flow tests with a page double: send, detect a new message, click `Continue`, then return the settled text.
- Regression test: a missing API message id cannot affect DOM continuation because the DOM path has no API continuation dependency.

## Out of Scope

- Vision/image uploads.
- Parallel DeepSeek chats.
- Changing provider ports or OpenCode configuration.
