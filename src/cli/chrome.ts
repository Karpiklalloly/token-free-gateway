import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAuthorizedProviders } from "../providers/auth-store.ts";

/** All web AI provider login pages, keyed by provider id */
const PROVIDER_URLS: Record<string, string> = {
	claude: "https://claude.ai/new",
	chatgpt: "https://chatgpt.com",
	deepseek: "https://chat.deepseek.com/",
	doubao: "https://www.doubao.com/chat/",
	qwen: "https://chat.qwen.ai",
	"qwen-cn": "https://www.qianwen.com",
	kimi: "https://www.kimi.com",
	gemini: "https://gemini.google.com/app",
	grok: "https://grok.com",
	glm: "https://chatglm.cn",
	"glm-intl": "https://chat.z.ai/",
	perplexity: "https://www.perplexity.ai",
	xiaomimo: "https://aistudio.xiaomimimo.com",
};

const CDP_PORT = 9222;

function detectChrome(): string | null {
	const platform = process.platform;

	if (platform === "darwin") {
		const candidates = [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		];
		for (const p of candidates) {
			if (existsSync(p)) return p;
		}
		return null;
	}

	if (platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const programFiles = process.env.PROGRAMFILES ?? "";
		const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "";
		const candidates = [
			join(localAppData, "Google/Chrome/Application/chrome.exe"),
			join(programFiles, "Google/Chrome/Application/chrome.exe"),
			join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
		];
		for (const p of candidates) {
			if (existsSync(p)) return p;
		}
		return null;
	}

	// Linux / WSL
	const candidates = [
		"/opt/apps/cn.google.chrome-pre/files/google/chrome/google-chrome",
		"/opt/google/chrome/google-chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

function getUserDataDir(): string {
	const platform = process.platform;
	if (platform === "darwin") {
		return join(homedir(), "Library/Application Support/Chrome-TFG-Debug");
	}
	if (platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local");
		return join(localAppData, "Chrome-TFG-Debug");
	}
	return join(homedir(), ".config/chrome-tfg-debug");
}

async function waitForCdp(port: number, timeoutMs = 15000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (res.ok) return true;
		} catch {}
		process.stdout.write(".");
		await Bun.sleep(1000);
	}
	return false;
}

async function isCdpAlreadyRunning(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		return res.ok;
	} catch {
		return false;
	}
}

export async function startChrome(openAllTabs = false) {
	if (await isCdpAlreadyRunning(CDP_PORT)) {
		console.log(`Chrome debug is already running on port ${CDP_PORT}.`);
		console.log("Run 'token-free-gateway chrome stop' to stop the existing instance first.");
		return;
	}

	const chromePath = detectChrome();
	if (!chromePath) {
		console.error(
			"✗ Chrome / Chromium not found.\n  Install Google Chrome: https://www.google.com/chrome/",
		);
		process.exit(1);
	}

	const userDataDir = getUserDataDir();

	console.log("==========================================");
	console.log("  Token-Free Gateway — Chrome Debug Mode");
	console.log("==========================================");
	console.log(`  Chrome  : ${chromePath}`);
	console.log(`  Profile : ${userDataDir}`);
	console.log(`  CDP     : http://127.0.0.1:${CDP_PORT}`);
	console.log("");

	const authorized = listAuthorizedProviders();
	const urls = openAllTabs
		? Object.values(PROVIDER_URLS)
		: authorized.map((id) => PROVIDER_URLS[id]).filter((u): u is string => Boolean(u));

	const flags = [
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-sync",
		"--disable-translate",
		"--disable-features=TranslateUI",
		"--remote-allow-origins=*",
		...urls,
	];

	const proc = Bun.spawn({
		cmd: [chromePath, ...flags],
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
		detached: true,
	});
	proc.unref();

	console.log("Waiting for Chrome to start");
	const ready = await waitForCdp(CDP_PORT);
	console.log("");

	if (!ready) {
		console.error("✗ Chrome failed to start within 15 seconds.");
		process.exit(1);
	}

	console.log("✓ Chrome is running in debug mode!");
	console.log("");
	console.log("==========================================");
	console.log("  Next steps:");
	console.log("==========================================");
	console.log("  1. Log in to each provider in the browser tabs");
	console.log("     (all provider pages have been opened automatically)");
	console.log("  2. Run: token-free-gateway webauth");
	console.log("  3. Run: token-free-gateway start");
	console.log("");
	console.log("  To stop Chrome debug mode:");
	console.log("    token-free-gateway chrome stop");
	console.log("==========================================");
}

export async function stopChrome() {
	if (process.platform === "win32") {
		const result = Bun.spawnSync({
			cmd: [
				"powershell",
				"-Command",
				`Get-NetTCPConnection -LocalPort ${CDP_PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
			],
			stdout: "ignore",
			stderr: "ignore",
		});
		if (result.exitCode === 0) {
			console.log("✓ Chrome debug instance stopped.");
		} else {
			console.log("No Chrome debug instance found on port 9222.");
		}
	} else {
		const result = Bun.spawnSync({
			cmd: ["pkill", "-f", `chrome.*remote-debugging-port=${CDP_PORT}`],
			stdout: "ignore",
			stderr: "ignore",
		});
		if (result.exitCode === 0) {
			console.log("✓ Chrome debug instance stopped.");
		} else {
			console.log("No Chrome debug instance found.");
		}
	}
}

export async function chromeCommand(subcommand: string | undefined) {
	if (!subcommand || subcommand === "start") {
		await startChrome();
	} else if (subcommand === "stop") {
		await stopChrome();
	} else {
		console.error(`Unknown chrome subcommand: ${subcommand}`);
		console.error("Usage: token-free-gateway chrome [start|stop]");
		process.exit(1);
	}
}
