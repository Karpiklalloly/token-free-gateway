import type { StreamResult } from "../types.ts";

const JUNK_TOKENS = new Set([
	"<｜end▁of▁thinking｜>",
	"<|end▁of▁thinking|>",
	"<｜end_of_thinking｜>",
	"<|end_of_thinking|>",
	"<|endoftext|>",
]);

function stripThinkingTags(input: string): { text: string; thinking: string } {
	let thinking = "";
	// Remove <think>...</think>, <thinking>...</thinking>, <thought>...</thought> blocks
	const re = /<(?:think(?:ing)?|thought)\b[^>]*>([\s\S]*?)<\/(?:think(?:ing)?|thought)>/gi;
	let m: RegExpExecArray | null;
	let lastIdx = 0;
	let cleaned = "";
	while (true) {
		m = re.exec(input);
		if (m === null) break;
		cleaned += input.slice(lastIdx, m.index);
		thinking += (thinking ? "\n" : "") + (m[1]?.trim() ?? "");
		lastIdx = m.index + m[0].length;
	}
	cleaned += input.slice(lastIdx);
	// Remove leftover unclosed opening tag and everything after? keep as thinking
	const openRe = /<(?:think(?:ing)?|thought)\b[^>]*>([\s\S]*)$/i;
	const openMatch = cleaned.match(openRe);
	if (openMatch) {
		thinking += (thinking ? "\n" : "") + (openMatch[1]?.trim() ?? "");
		cleaned = cleaned.replace(openRe, "");
	}
	return { text: cleaned, thinking };
}

function isThinkingFragmentType(t: unknown): boolean {
	if (typeof t !== "string") return false;
	const low = t.toLowerCase();
	return (
		low === "thinking" ||
		low === "reasoning" ||
		low === "thought" ||
		low === "think" ||
		low.includes("thinking") ||
		low.includes("reasoning")
	);
}

export async function parseDeepSeekStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
	onParentMessageId?: (id: string | number) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let thinkingText = "";

	let currentMode: "text" | "thinking" | "tool_call" = "text";
	let tagBuffer = "";
	// DeepSeek web fragments: THINK vs RESPONSE — subsequent
	// p=response/fragments/-1/content and p=undefined APPENDs inherit last fragment type
	let activeFragmentType: "thinking" | "text" | null = null;

	const stripJunk = (s: string): string => {
		let out = s;
		for (const tok of JUNK_TOKENS) {
			if (out.includes(tok)) out = out.split(tok).join("");
		}
		return out;
	};
	const emitText = (delta: string) => {
		if (!delta) return;
		const cleaned = stripJunk(delta);
		if (!cleaned || JUNK_TOKENS.has(cleaned)) return;
		text += cleaned;
		onDelta?.(cleaned);
	};

	const emitThinking = (delta: string) => {
		if (!delta) return;
		const cleaned = stripJunk(delta);
		if (!cleaned || JUNK_TOKENS.has(cleaned)) return;
		thinkingText += cleaned;
	};

	const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
		if (!delta) return;
		if (forceType === "thinking") {
			emitThinking(delta);
			return;
		}
		tagBuffer += delta;

		const checkTags = () => {
			const thinkStartMatch = tagBuffer.match(/<(?:think(?:ing)?|thought)\b[^<>]*>/i);
			const thinkEndMatch = tagBuffer.match(/<\/(?:think(?:ing)?|thought)\b[^<>]*>/i);
			const toolCallStartMatch =
				tagBuffer.match(
					/<tool_call\s+(?:id=['"]?([^'"]+)['"]?\s+)?name=['"]?([^'"]+)['"]?(?:\s+id=['"]?([^'"]+)['"]?)?\s*>/i,
				) || tagBuffer.match(/<tool_call\s+id=['"]?([^'"]+)['"]?\s*>/i);
			const toolCallEndMatch = tagBuffer.match(/<\/tool_call\b[^<>]*>/i);

			const indices = [
				{
					type: "think_start" as const,
					idx: thinkStartMatch?.index ?? -1,
					len: thinkStartMatch?.[0].length ?? 0,
				},
				{
					type: "think_end" as const,
					idx: thinkEndMatch?.index ?? -1,
					len: thinkEndMatch?.[0].length ?? 0,
				},
				{
					type: "tool_start" as const,
					idx: toolCallStartMatch?.index ?? -1,
					len: toolCallStartMatch?.[0].length ?? 0,
					name: toolCallStartMatch?.[2] || toolCallStartMatch?.[1] || "",
				},
				{
					type: "tool_end" as const,
					idx: toolCallEndMatch?.index ?? -1,
					len: toolCallEndMatch?.[0].length ?? 0,
				},
			]
				.filter((t) => t.idx !== -1)
				.toSorted((a, b) => a.idx - b.idx);

			if (indices.length > 0) {
				const first = indices[0];
				if (!first) return;
				const before = tagBuffer.slice(0, first.idx);
				if (before) {
					if (currentMode === "thinking") emitThinking(before);
					else if (currentMode === "tool_call") emitText(before);
					else emitText(before);
				}
				if (first.type === "think_start") {
					currentMode = "thinking";
				} else if (first.type === "think_end") {
					currentMode = "text";
				} else if (first.type === "tool_start") {
					currentMode = "tool_call";
				} else if (first.type === "tool_end") {
					currentMode = "text";
				}
				tagBuffer = tagBuffer.slice(first.idx + first.len);
				checkTags();
			} else {
				const lastAngle = tagBuffer.lastIndexOf("<");
				if (lastAngle === -1) {
					if (currentMode === "thinking") emitThinking(tagBuffer);
					else if (currentMode === "tool_call") emitText(tagBuffer);
					else emitText(tagBuffer);
					tagBuffer = "";
				} else if (lastAngle > 0) {
					const safe = tagBuffer.slice(0, lastAngle);
					if (currentMode === "thinking") emitThinking(safe);
					else if (currentMode === "tool_call") emitText(safe);
					else emitText(safe);
					tagBuffer = tagBuffer.slice(lastAngle);
				}
			}
		};
		checkTags();
	};

	const processLine = (line: string) => {
		if (!line) return;
		if (line.startsWith("event: ")) return;

		if (line.startsWith("data: ")) {
			const dataStr = line.slice(6).trim();
			if (dataStr === "[DONE]" || !dataStr) return;

			try {
				const data = JSON.parse(dataStr) as Record<string, unknown>;

				if (
					typeof data.response_message_id === "number" ||
					typeof data.response_message_id === "string"
				) {
					onParentMessageId?.(data.response_message_id as string | number);
				}

				const pField = data.p;
				const pStr = typeof pField === "string" ? pField.toLowerCase() : "";
				const typeStr = typeof data.type === "string" ? (data.type as string).toLowerCase() : "";
				const isThinkingP =
					pStr.includes("reasoning") || pStr.includes("thinking") || pStr.includes("thought");
				const isThinkingType =
					typeStr.includes("thinking") ||
					typeStr.includes("reasoning") ||
					typeStr.includes("thought") ||
					typeStr === "think";

				// Any reasoning/thinking payload routed to thinkingText
				if (isThinkingP && typeof data.v === "string") {
					pushDelta(data.v, "thinking");
					return;
				}
				if (isThinkingType && typeof data.v === "string") {
					pushDelta(data.v, "thinking");
					return;
				}
				if (isThinkingType && typeof data.content === "string") {
					pushDelta(data.content, "thinking");
					return;
				}

				// Fragment content appends (p=response/fragments/-1/content or bare v with active fragment)
				// These must be routed by activeFragmentType, not generic content handler
				if (
					typeof data.v === "string" &&
					(pStr === "response/fragments/-1/content" || (!pField && activeFragmentType !== null))
				) {
					// ignore elapsed_secs etc which are not content but same p prefix — only content uses string v without elapsed
					if (pStr.includes("elapsed")) return;
					if (activeFragmentType === "thinking") {
						pushDelta(data.v, "thinking");
					} else {
						pushDelta(data.v);
					}
					return;
				}

				if (
					typeof data.v === "string" &&
					(!pField || pStr.includes("content") || pStr.includes("choices"))
				) {
					// fallback for non-fragment content (e.g. response/content)
					pushDelta(data.v);
					return;
				}
				if (typeStr === "text" && typeof data.content === "string") {
					pushDelta(data.content);
					return;
				}

				if (typeStr === "search_result" || String(data.p || "").includes("search_results")) {
					const searchData = data.v ?? data.content;
					const query =
						typeof searchData === "string" ? searchData : (searchData as { query?: string })?.query;
					if (query) {
						pushDelta(`\n> [Researching: ${query}...]\n`);
					}
					return;
				}

				if (Array.isArray(data.v)) {
					// p=response/fragments APPEND — track active fragment type for subsequent -1/content appends
					if (pStr === "response/fragments" || pStr.includes("fragments")) {
						for (const frag of data.v as Array<Record<string, unknown>>) {
							const isThink = isThinkingFragmentType(frag.type);
							activeFragmentType = isThink ? "thinking" : "text";
							// emit initial fragment content if present
							if (isThink) {
								pushDelta(String(frag.content || ""), "thinking");
							} else if (frag.content) {
								pushDelta(String(frag.content));
							}
						}
						return;
					}
					for (const frag of data.v as Array<Record<string, unknown>>) {
						if (isThinkingFragmentType(frag.type)) {
							pushDelta(String(frag.content || ""), "thinking");
						} else if (frag.content) {
							pushDelta(String(frag.content));
						}
					}
					return;
				}

				const fragments = (data.v as { response?: { fragments?: unknown[] } } | undefined)?.response
					?.fragments;
				if (Array.isArray(fragments)) {
					for (const frag of fragments as Array<{ type?: string; content?: string }>) {
						const isThink = isThinkingFragmentType(frag.type);
						// init sync: set active to last fragment type
						activeFragmentType = isThink ? "thinking" : "text";
						if (isThink) {
							pushDelta(frag.content || "", "thinking");
						} else if (frag.content) {
							pushDelta(frag.content);
						}
					}
					return;
				}

				const choice = (
					data.choices as Array<{
						delta?: { reasoning_content?: string; thinking_content?: string; content?: string };
					}>
				)?.[0];
				if (choice?.delta) {
					if (choice.delta.reasoning_content) {
						pushDelta(choice.delta.reasoning_content, "thinking");
					}
					if ((choice.delta as Record<string, unknown>).thinking_content) {
						pushDelta(
							String((choice.delta as Record<string, unknown>).thinking_content),
							"thinking",
						);
					}
					if (choice.delta.content) {
						pushDelta(choice.delta.content);
					}
				}
			} catch {
				// ignore partial JSON
			}
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) processLine(buffer.trim());
				if (tagBuffer) {
					if ((currentMode as string) === "thinking") emitThinking(tagBuffer);
					else emitText(tagBuffer);
					tagBuffer = "";
				}
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			const combined = buffer + chunk;
			const parts = combined.split("\n");
			buffer = parts.pop() || "";
			for (const part of parts) {
				processLine(part.trim());
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Final defensive stripping: remove any <think> blocks that slipped through text
	const stripped = stripThinkingTags(text);
	if (stripped.thinking) {
		thinkingText = (thinkingText ? `${thinkingText}\n` : "") + stripped.thinking;
		text = stripped.text;
	}
	// Also filter junk tokens that may be surrounded by whitespace
	for (const tok of JUNK_TOKENS) {
		text = text.split(tok).join("");
		thinkingText = thinkingText.split(tok).join("");
	}

	return { text: text.trim(), thinkingText: thinkingText.trim() };
}
