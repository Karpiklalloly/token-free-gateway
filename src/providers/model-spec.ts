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
