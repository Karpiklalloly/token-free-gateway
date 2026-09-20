const gatewayProviders = new Set(["pricol", "prikol1"]);

export const DeepSeekChatRouting = async () => ({
	"chat.headers": async (
		input: { sessionID: string; provider?: { info?: { id?: string }; id?: string } },
		output: { headers: Record<string, string> },
	) => {
		const providerId = input.provider?.info?.id ?? input.provider?.id;
		if (!providerId || !gatewayProviders.has(providerId)) return;
		output.headers["X-TFG-Conversation-ID"] = input.sessionID;
	},
});
