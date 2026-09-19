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

	test("returns single tool call as array", () => {
		const text = '```tool_json\n{"tool":"exec","parameters":{"command":"ls"}}\n```';
		const result = extractToolCalls(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("exec");
	});

	test("returns empty array for plain text", () => {
		expect(extractToolCalls("No tools here")).toEqual([]);
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
