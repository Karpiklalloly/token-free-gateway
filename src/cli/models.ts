import { loadConfig } from "../config.ts";
import {
	listAllModels,
	refreshModels,
	resolveModelToProvider,
} from "../providers/registry.ts";

function daemonBaseUrl(): string {
	return `http://localhost:${loadConfig().port}`;
}

async function tryDaemon(path: string, method: string): Promise<unknown | null> {
	try {
		const headers: Record<string, string> = {};
		if (loadConfig().gatewayApiKey) headers.Authorization = `Bearer ${loadConfig().gatewayApiKey}`;
		const res = await fetch(`${daemonBaseUrl()}${path}`, {
			method,
			headers,
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		return (await res.json()) as unknown;
	} catch {
		return null;
	}
}

/**
 * `models [provider] [--refresh] [--json]`
 * Daemon running → HTTP; otherwise standalone registry calls.
 */
export async function modelsCommand(rawArgs: string[]): Promise<void> {
	const wantRefresh = rawArgs.includes("--refresh");
	const asJson = rawArgs.includes("--json");
	const provider = rawArgs.find((a) => !a.startsWith("--"));

	if (wantRefresh) {
		const via = provider
			? null
			: await tryDaemon("/v1/models/refresh", "POST");
		const report = via ?? (await refreshModels(provider));
		if (asJson) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			const r = report as { refreshed: string[]; failed: { provider: string; reason: string }[]; models: number };
			console.log(`Refreshed: ${r.refreshed.length > 0 ? r.refreshed.join(", ") : "none"}`);
			for (const f of r.failed) console.log(`  ✗ ${f.provider}: ${f.reason}`);
			console.log(`Models: ${r.models}`);
		}
		if ((report as { refreshed: string[] }).refreshed.length === 0) process.exit(1);
		return;
	}

	const viaGet = await tryDaemon("/v1/models", "GET");
	let rows: { id: string; owned_by: string }[];
	if (viaGet && typeof viaGet === "object" && Array.isArray((viaGet as { data: unknown }).data)) {
		rows = (viaGet as { data: { id: string; owned_by: string }[] }).data;
	} else {
		const models = await listAllModels();
		rows = await Promise.all(
			models.map(async (m) => ({
				id: m.id,
				owned_by: (await resolveModelToProvider(m.id)) ?? "web-provider",
			})),
		);
	}
	const filtered = provider ? rows.filter((r) => r.owned_by === provider || r.id === provider) : rows;
	if (asJson) {
		console.log(JSON.stringify({ object: "list", data: filtered }, null, 2));
	} else if (filtered.length === 0) {
		console.log("No models. Run 'token-free-gateway webauth' to authorize providers.");
	} else {
		for (const r of filtered) console.log(`${r.id}  (${r.owned_by})`);
	}
}
