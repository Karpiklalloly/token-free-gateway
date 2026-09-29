/**
 * Parse tool calls from web model text responses.
 *
 * Migrated from openclaw-zero-token web-tool-parser.ts.
 * Supports multiple formats (tried in order):
 * 1. Fenced: ```tool_json\n{"tool":"...","parameters":{...}}\n```
 * 2. Bare JSON: {"tool":"...","parameters":{...}} or {"tool":"...",...args}
 * 3. XML: <tool_call>{"name":"...","arguments":{...}}</tool_call>
 * 4. OpenAI-native: {"tool_calls":[{"name":"...","arguments":{...}}]}
 */

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

const FENCED_REGEX = /```tool_json\s*\n?\s*(\{[\s\S]*\})\s*\n?\s*```/;
const XML_TOOL_REGEX = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/;
const OPENAI_TOOL_CALLS_REGEX =
	/\{\s*"tool_calls"\s*:\s*\[\s*(\{[\s\S]*?\})\s*(?:,[\s\S]*?)?\]\s*\}/;
// Hallucinated bracket format seen on DeepSeek Web, e.g.
// [Calling terminal with command: ls -la "D:/x/"]
const BRACKET_CALL_REGEX =
	/\[\s*Calling\s+([A-Za-z_][\w-]*)\s+with\s+command\s*:\s*([\s\S]*?)\s*\]/i;
const DSML_INVOKE_REGEX =
	/<｜DSML｜invoke\b[^>]*\bname=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/｜DSML｜invoke>/g;
const DSML_PARAMETER_REGEX =
	/<｜DSML｜parameter\b[^>]*\bname=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/｜DSML｜parameter>/g;
const DSML_INVOKE_DETECT_REGEX = /<｜DSML｜invoke\b[^>]*\bname=["']/;
const FUNCTION_CALL_LINE_REGEX = /^\s*([A-Za-z_][\w-]*)\((.*)\)\s*$/gm;
const FUNCTION_CALL_DETECT_REGEX = /^\s*[A-Za-z_][\w-]*\(.+=.*\)\s*$/m;

function normalizeDsmlTags(text: string): string {
	return text.replace(
		/<\s*(\/?)\s*[|｜]+\s*DSML\s*[|｜]+\s*/gi,
		(_, close: string) => `<${close}｜DSML｜`,
	);
}

function extractBalancedJsonObject(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return text.slice(start, i + 1);
	}

	return null;
}

function extractBareToolCalls(text: string): ParsedToolCall[] {
	const sources = [text];
	const unescaped = text.replace(/\\"/g, '"');
	if (unescaped !== text) sources.push(unescaped);

	for (const source of sources) {
		const calls: ParsedToolCall[] = [];
		const marker = /\{\s*"tool"\s*:/g;
		let match = marker.exec(source);

		while (match) {
			const raw = extractBalancedJsonObject(source, match.index);
			if (!raw) break;
			const parsed = parseToolJson(raw);
			if (parsed) calls.push(parsed);
			marker.lastIndex = match.index + raw.length;
			match = marker.exec(source);
		}

		if (calls.length > 0) return calls;
	}

	return [];
}

function extractBareToolCall(text: string): ParsedToolCall | null {
	return extractBareToolCalls(text)[0] ?? null;
}

function extractDsmlToolCalls(text: string): ParsedToolCall[] {
	text = normalizeDsmlTags(text);
	const calls: ParsedToolCall[] = [];
	for (const invoke of text.matchAll(DSML_INVOKE_REGEX)) {
		const arguments_: Record<string, unknown> = {};
		for (const parameter of (invoke[3] ?? "").matchAll(DSML_PARAMETER_REGEX)) {
			const value = (parameter[3] ?? "").trim();
			const isString = /\bstring\s*=\s*(["'])false\1/i.test(parameter[0] ?? "");
			try {
				arguments_[parameter[2] ?? ""] = isString ? JSON.parse(value) : value;
			} catch {
				arguments_[parameter[2] ?? ""] = value;
			}
		}
		if (invoke[2]) calls.push({ name: invoke[2], arguments: arguments_ });
	}
	return calls;
}

function extractFunctionToolCalls(text: string): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];
	for (const match of text.matchAll(FUNCTION_CALL_LINE_REGEX)) {
		const args: Record<string, unknown> = {};
		let valid = true;
		for (const part of (match[2] ?? "").split(/,\s*(?=[A-Za-z_]\w*\s*=)/)) {
			const argument = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(part.trim());
			if (!argument) {
				valid = false;
				break;
			}
			const raw = argument[2] ?? "";
			try {
				args[argument[1] ?? ""] = JSON.parse(raw);
			} catch {
				args[argument[1] ?? ""] = raw.startsWith('"') && raw.endsWith('"')
					? raw.slice(1, -1)
					: raw;
			}
		}
		if (valid && Object.keys(args).length && match[1]) calls.push({ name: match[1], arguments: args });
	}
	return calls;
}

export function extractToolCalls(text: string): ParsedToolCall[] {
	// Try extracting multiple fenced tool_json blocks first
	const fencedMatches = [...text.matchAll(/```tool_json\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g)];
	if (fencedMatches.length > 0) {
		const calls: ParsedToolCall[] = [];
		for (const match of fencedMatches) {
			const parsed = parseToolJson(match[1] ?? "");
			if (parsed) calls.push(parsed);
		}
		if (calls.length > 0) return calls;
	}

	// Try extracting multiple XML tool_calls
	const xmlMatches = [...text.matchAll(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/g)];
	if (xmlMatches.length > 0) {
		const calls: ParsedToolCall[] = [];
		for (const match of xmlMatches) {
			const parsed = parseToolJson(match[1] ?? "");
			if (parsed) calls.push(parsed);
		}
		if (calls.length > 0) return calls;
	}

	const dsmlCalls = extractDsmlToolCalls(text);
	if (dsmlCalls.length > 0) return dsmlCalls;

	const functionCalls = extractFunctionToolCalls(text);
	if (functionCalls.length > 0) return functionCalls;

	const bareCalls = extractBareToolCalls(text);
	if (bareCalls.length > 0) return bareCalls;

	// Try single extraction (fallback)
	const single = extractSingleToolCall(text);
	return single ? [single] : [];
}

export function extractSingleToolCall(text: string): ParsedToolCall | null {
	// 1. Fenced code block
	const fenced = FENCED_REGEX.exec(text);
	if (fenced?.[1]) return parseToolJson(fenced[1]);

	const dsml = extractDsmlToolCalls(text);
	if (dsml[0]) return dsml[0];

	const functionCall = extractFunctionToolCalls(text)[0];
	if (functionCall) return functionCall;

	// 2. OpenAI-style tool_calls array
	const openai = OPENAI_TOOL_CALLS_REGEX.exec(text);
	if (openai?.[1]) return parseToolJson(openai[1]);

	// 3. Bare JSON with tool/parameters
	const bare = extractBareToolCall(text);
	if (bare) return bare;

	// 4. XML format
	const xml = XML_TOOL_REGEX.exec(text);
	if (xml?.[1]) return parseToolJson(xml[1]);

	// 5. Hallucinated bracket format: [Calling <tool> with command: <cmd>]
	const bracket = BRACKET_CALL_REGEX.exec(text);
	if (bracket?.[1] && bracket?.[2] !== undefined) {
		return { name: bracket[1].toLowerCase(), arguments: { command: bracket[2].trim() } };
	}

	// 6. Fuzzy repair: truncated JSON
	const fuzzy = text.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*\{([^}]*)\}/);
	if (fuzzy?.[1] && fuzzy?.[2] !== undefined) {
		const repaired = `{"tool":"${fuzzy[1]}","parameters":{${fuzzy[2]}}}`;
		return parseToolJson(repaired);
	}

	return null;
}

function parseToolJson(raw: string): ParsedToolCall | null {
	const candidates = [raw.trim()];
	const unescaped = raw.replace(/\\"/g, '"').trim();
	if (unescaped !== candidates[0]) candidates.push(unescaped);

	for (const cleaned of candidates) {
		try {
			let obj;
			try {
				obj = JSON.parse(cleaned);
			} catch {
				// Repair a genuinely truncated object; braces inside JSON strings are data.
				let depth = 0;
				let inString = false;
				let escaped = false;
				for (const char of cleaned) {
					if (inString) {
						if (escaped) escaped = false;
						else if (char === "\\") escaped = true;
						else if (char === '"') inString = false;
					} else if (char === '"') inString = true;
					else if (char === "{") depth++;
					else if (char === "}") depth--;
				}
				if (inString || depth <= 0) continue;
				obj = JSON.parse(cleaned + "}".repeat(depth));
			}

			// Format: {"tool":"name","parameters":{...}}
			if (typeof obj.tool === "string") {
				const arguments_ =
					obj.parameters === undefined
						? Object.fromEntries(Object.entries(obj).filter(([key]) => key !== "tool"))
						: (obj.parameters ?? {});
				return { name: obj.tool, arguments: arguments_ };
			}
			// Format: {"name":"...","arguments":{...}}
			if (typeof obj.name === "string") {
				return { name: obj.name, arguments: obj.arguments ?? {} };
			}
		} catch {
			// Try the next representation.
		}
	}

	return null;
}

export function hasToolCall(text: string): boolean {
	return (
		FENCED_REGEX.test(text) ||
		extractBareToolCall(text) !== null ||
		XML_TOOL_REGEX.test(text) ||
		OPENAI_TOOL_CALLS_REGEX.test(text) ||
		DSML_INVOKE_DETECT_REGEX.test(normalizeDsmlTags(text)) ||
		FUNCTION_CALL_DETECT_REGEX.test(text) ||
		BRACKET_CALL_REGEX.test(text)
	);
}
