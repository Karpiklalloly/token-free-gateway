export type ChatTrace = {
	id: string;
	conversationId: string | null;
	model: string;
	stream: boolean;
};

export function formatChatTrace(
	trace: ChatTrace,
	event:
		| { event: "received" }
		| { event: "completed"; status: number; elapsedMs: number }
		| { event: "failed"; elapsedMs: number; error: string },
): string {
	if (event.event === "received") {
		return `[chat-trace] ${trace.id} received chat=${trace.conversationId ?? "none"} model=${trace.model || "none"} stream=${trace.stream}`;
	}
	if (event.event === "completed") {
		return `[chat-trace] ${trace.id} completed status=${event.status} elapsed_ms=${event.elapsedMs}`;
	}
	return `[chat-trace] ${trace.id} failed error=${event.error} elapsed_ms=${event.elapsedMs}`;
}
