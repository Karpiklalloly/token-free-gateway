import { describe, expect, test } from "bun:test";
import {
	extractSingleToolCall,
	extractToolCalls,
	hasToolCall,
} from "../src/tool-calling/parser.ts";

describe("extractSingleToolCall", () => {
	test("parses fenced tool_json block", () => {
		const text = `Sure, I'll search for that.

\`\`\`tool_json
{"tool":"web_search","parameters":{"query":"bun runtime"}}
\`\`\``;
		const result = extractSingleToolCall(text);
		expect(result).toEqual({
			name: "web_search",
			arguments: { query: "bun runtime" },
		});
	});

	test("parses a tool_json block after explanatory text", () => {
		const text = `I need to trace where ContentPart[] is converted/sent. Let me look at the request handling and provider clients.
\`\`\`tool_json
{"tool":"grep","parameters":{"pattern":"ContentPart|content as|\\\\.content|role === \\\"user\\\"|role: \\\"user\\\"","path":"C:\\\\workspace\\\\src","include":"*.ts"}}
\`\`\``;
		expect(extractSingleToolCall(text)).toEqual({
			name: "grep",
			arguments: {
				pattern: 'ContentPart|content as|\\.content|role === "user"|role: "user"',
				path: "C:\\workspace\\src",
				include: "*.ts",
			},
		});
	});

	test("parses DOM text when tool_json fences become Copy Download text", () => {
		const text = `I need to trace where ContentPart[] is converted/sent. Let me look at the request handling and provider clients.
tool_json
Copy Download
{"tool":"grep","parameters":{"pattern":"ContentPart|content as|\\\\.content","path":"C:\\\\workspace\\\\src","include":"*.ts"}}`;
		expect(hasToolCall(text)).toBe(true);
		expect(extractSingleToolCall(text)).toEqual({
			name: "grep",
			arguments: {
				pattern: "ContentPart|content as|\\.content",
				path: "C:\\workspace\\src",
				include: "*.ts",
			},
		});
	});

	test("parses DOM tool_json with nested braces inside edit strings", () => {
		const payload = JSON.stringify({
			tool: "edit",
			parameters: {
				filePath: "C:\\src\\converter.ts",
				oldString: "function f() {\n\treturn { ok: true };\n}",
				newString: "function f() {\n\treturn { ok: false };\n}",
			},
		});
		const text = `Тесты проходят. Применяю.\ntool_json\nCopy\nDownload\n${payload}`;
		expect(extractSingleToolCall(text)).toEqual({
			name: "edit",
			arguments: JSON.parse(payload).parameters,
		});
	});

	test("parses DOM tool_json with nested parameter objects", () => {
		const payload = JSON.stringify({
			tool: "edit",
			parameters: { filePath: "C:\\src\\converter.ts", options: { selection: { start: 1, end: 2 } } },
		});
		const text = `tool_json Copy Download ${payload}`;
		expect(extractSingleToolCall(text)).toEqual({
			name: "edit",
			arguments: JSON.parse(payload).parameters,
		});
	});

	test("parses escaped DOM tool_json payloads", () => {
		const payload = JSON.stringify({
			tool: "edit",
			parameters: {
				filePath: "C:\\src\\client.ts",
				oldString: "function f() {\n\treturn { ok: true };\n}",
				newString: "function f() {\n\treturn { ok: false };\n}",
			},
		}).replace(/"/g, '\\"');
		const text = `tool_json Copy Download ${payload}`;

		expect(hasToolCall(text)).toBe(true);
		expect(extractSingleToolCall(text)).toEqual({
			name: "edit",
			arguments: JSON.parse(payload.replace(/\\"/g, '"')).parameters,
		});
	});

	test("preserves top-level arguments in a tool_json block", () => {
		const text = `\`\`\`tool_json
{"tool":"task","description":"Inspect images","prompt":"Explore the project","subagent_type":"explore"}
\`\`\``;
		expect(extractSingleToolCall(text)).toEqual({
			name: "task",
			arguments: {
				description: "Inspect images",
				prompt: "Explore the project",
				subagent_type: "explore",
			},
		});
	});

	test("parses bare JSON with tool/parameters", () => {
		const text = 'I need to run a command. {"tool":"exec","parameters":{"command":"ls -la"}}';
		const result = extractSingleToolCall(text);
		expect(result).toEqual({
			name: "exec",
			arguments: { command: "ls -la" },
		});
	});

	test("parses XML tool_call format", () => {
		const text =
			'<tool_call name="read">{"name":"read","arguments":{"path":"/tmp/file.txt"}}</tool_call>';
		const result = extractSingleToolCall(text);
		expect(result).toEqual({
			name: "read",
			arguments: { path: "/tmp/file.txt" },
		});
	});

	test("parses OpenAI-style tool_calls wrapper", () => {
		const text = '{"tool_calls":[{"name":"exec","arguments":{"command":"pwd"}}]}';
		const result = extractSingleToolCall(text);
		expect(result).toEqual({
			name: "exec",
			arguments: { command: "pwd" },
		});
	});

	test("handles truncated JSON with fuzzy repair", () => {
		const text = '{"tool":"exec","parameters":{"command":"ls"}';
		const result = extractSingleToolCall(text);
		expect(result).toEqual({
			name: "exec",
			arguments: { command: "ls" },
		});
	});

	test("parses bracket Calling hallucination (DeepSeek)", () => {
		const text = 'Хорошо, посмотрю сама.\n\n[Calling terminal with command: ls -la "D:/sdktest/tasks/"]';
		const result = extractSingleToolCall(text);
		expect(result).toEqual({
			name: "terminal",
			arguments: { command: 'ls -la "D:/sdktest/tasks/"' },
		});
	});

	test("parses DeepSeek DSML invocation", () => {
		const text = `<｜DSML｜calls><｜DSML｜invoke name="task"><｜DSML｜parameter name="description" string="true">Find tab-opening logic</｜DSML｜parameter><｜DSML｜parameter name="prompt" string="true">Explore the codebase</｜DSML｜parameter><｜DSML｜parameter name="subagent_type" string="true">explore</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>`;
		expect(extractSingleToolCall(text)).toEqual({
			name: "task",
			arguments: {
				description: "Find tab-opening logic",
				prompt: "Explore the codebase",
				subagent_type: "explore",
			},
		});
	});

	test("returns null for plain text", () => {
		const text = "Hello, I'm just a regular response with no tool calls.";
		expect(extractSingleToolCall(text)).toBeNull();
	});
});

describe("extractToolCalls", () => {
	test("extracts multiple XML tool calls", () => {
		const text = `<tool_call name="read">{"name":"read","arguments":{"path":"a.txt"}}</tool_call>
<tool_call name="read">{"name":"read","arguments":{"path":"b.txt"}}</tool_call>`;
		const result = extractToolCalls(text);
		expect(result).toHaveLength(2);
		expect(result[0]?.name).toBe("read");
		expect(result[1]?.name).toBe("read");
	});

	test("extracts multiple DOM tool_json blocks after fences are stripped", () => {
		const text = `Now let me read the files.
tool_json Copy Download {"tool":"read","filePath":"C:\\\\src\\\\base-dom-client.ts"}
tool_json Copy Download {"tool":"grep","pattern":"setInputFiles|clipboard|paste","include":"*.ts","path":"C:\\\\src"}`;
		expect(extractToolCalls(text)).toEqual([
			{ name: "read", arguments: { filePath: "C:\\src\\base-dom-client.ts" } },
			{ name: "grep", arguments: { pattern: "setInputFiles|clipboard|paste", include: "*.ts", path: "C:\\src" } },
		]);
	});

	test("returns single tool call as array", () => {
		const text = '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}}\n```';
		const result = extractToolCalls(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("exec");
	});

	test("returns empty array for plain text", () => {
		expect(extractToolCalls("No tools here")).toEqual([]);
	});

	test("extracts Hermes-style calls with numeric arguments and nested command quotes", () => {
		const text = `search_files(pattern="SOUL.md", target="files", path="C:/tmp/hermes", limit=20)

search_files(pattern="SOUL", target="files", path="C:/tmp/hermes", limit=20)

terminal(command="ls -la "$LOCALAPPDATA/hermes" 2>/dev/null | head -50")`;
		expect(extractToolCalls(text)).toEqual([
			{ name: "search_files", arguments: { pattern: "SOUL.md", target: "files", path: "C:/tmp/hermes", limit: 20 } },
			{ name: "search_files", arguments: { pattern: "SOUL", target: "files", path: "C:/tmp/hermes", limit: 20 } },
			{ name: "terminal", arguments: { command: 'ls -la "$LOCALAPPDATA/hermes" 2>/dev/null | head -50' } },
		]);
	});
});

describe("hasToolCall", () => {
	test("detects fenced block", () => {
		expect(hasToolCall('```tool_json\n{"tool":"x","parameters":{}}\n```')).toBe(true);
	});

	test("detects bare JSON", () => {
		expect(hasToolCall('{"tool":"x","parameters":{}}')).toBe(true);
	});

	test("detects XML", () => {
		expect(hasToolCall("<tool_call>x</tool_call>")).toBe(true);
	});

	test("detects bracket Calling hallucination", () => {
		expect(hasToolCall('[Calling terminal with command: ls -la "D:/x/"]')).toBe(true);
	});

	test("returns false for plain text", () => {
		expect(hasToolCall("just some text")).toBe(false);
	});
});
