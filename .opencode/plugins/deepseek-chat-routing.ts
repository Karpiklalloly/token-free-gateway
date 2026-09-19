const gatewayProviders = new Set(["pricol", "prikol1"]);

export const DeepSeekChatRouting = async () => ({
	"chat.headers": async (
		input: { sessionID: string; provider: { id: string } },
		output: { headers: Record<string, string> },
	) => {
		if (!gatewayProviders.has(input.provider.id)) return;
		output.headers["X-TFG-Conversation-ID"] = input.sessionID;
	},
});
