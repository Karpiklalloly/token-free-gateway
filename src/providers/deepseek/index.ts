import type { ProviderDefinition } from "../types.ts";
import type { DeepSeekWebCredentials } from "./auth.ts";
import { loginDeepseekWeb } from "./auth.ts";
import { DeepSeekWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "deepseek-web",
	name: "DeepSeek Web",
	models: [
		{ id: "deepseek-chat", name: "DeepSeek Chat" },
		{ id: "deepseek-chat:think", name: "DeepSeek Chat (thinking)" },
		{ id: "deepseek-chat:search-off", name: "DeepSeek Chat (no search)" },
		{ id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
		{ id: "deepseek-reasoner:no-think", name: "DeepSeek Reasoner (no thinking)" },
		{ id: "deepseek-reasoner:search-off", name: "DeepSeek Reasoner (no search)" },
	],
	factory: (credentials) => new DeepSeekWebClient(credentials as DeepSeekWebCredentials),
	loginFn: loginDeepseekWeb,
};
