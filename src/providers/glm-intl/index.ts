import type { ProviderDefinition } from "../types.ts";
import { loginGlmIntlWeb } from "./auth.ts";
import { GlmIntlWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "glm-intl-web",
	name: "GLM International (Web)",
	models: [
		{ id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
		{ id: "glm-5.3", name: "GLM 5.3" },
		{ id: "glm-5.2", name: "GLM 5.2" },
	],
	factory: (credentials) => new GlmIntlWebClient(credentials as any),
	loginFn: loginGlmIntlWeb,
};
