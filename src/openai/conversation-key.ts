const HEADER = "X-TFG-Conversation-ID";

export function resolveConversationKey(request: Request): string | null {
	const value = request.headers.get(HEADER)?.trim();
	return value || null;
}
