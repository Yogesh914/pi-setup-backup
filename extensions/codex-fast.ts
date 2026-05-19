import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-fast";
const SETTING_NS = "pi-codex-fast";
const LEGACY_DOTTED_KEY = "pi-codex-fast.enabled";

type JsonObject = Record<string, unknown>;

function readEnabledFrom(settings: JsonObject | undefined): boolean | undefined {
	if (!settings) return undefined;
	const dotted = settings[LEGACY_DOTTED_KEY];
	if (typeof dotted === "boolean") return dotted;

	const nested = settings[SETTING_NS];
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		const value = (nested as JsonObject).enabled;
		if (typeof value === "boolean") return value;
	}

	return undefined;
}

function createSettingsManager(cwd: string) {
	return SettingsManager.create(cwd, getAgentDir());
}

function readEnabled(cwd: string): boolean {
	const settings = createSettingsManager(cwd);
	const globalEnabled = readEnabledFrom(settings.getGlobalSettings() as JsonObject);
	const projectEnabled = readEnabledFrom(settings.getProjectSettings() as JsonObject);
	return projectEnabled ?? globalEnabled ?? false;
}

async function writeGlobalEnabled(enabled: boolean): Promise<void> {
	const settingsPath = join(getAgentDir(), "settings.json");
	await mkdir(dirname(settingsPath), { recursive: true });

	let current: JsonObject = {};
	try {
		const raw = await readFile(settingsPath, "utf8");
		current = raw.trim() ? (JSON.parse(raw) as JsonObject) : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const ns = current[SETTING_NS];
	const nextNs: JsonObject = ns && typeof ns === "object" && !Array.isArray(ns) ? { ...(ns as JsonObject) } : {};
	nextNs.enabled = enabled;
	current[SETTING_NS] = nextNs;

	await writeFile(settingsPath, `${JSON.stringify(current, null, "\t")}\n`, "utf8");
}

function setStatus(ctx: ExtensionContext, enabled: boolean) {
	ctx.ui.setStatus(STATUS_KEY, enabled ? "fast: priority" : undefined);
}

export default function codexFast(pi: ExtensionAPI) {
	let enabled = false;

	pi.registerFlag("fast", {
		description: "Enable OpenAI/Codex priority service tier for this and future pi runs",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle OpenAI/Codex priority service tier",
		handler: async (_args, ctx) => {
			enabled = !readEnabled(ctx.cwd);
			await writeGlobalEnabled(enabled);
			setStatus(ctx, enabled);
			ctx.ui.notify(`Codex fast mode ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = readEnabled(ctx.cwd);

		if (pi.getFlag("fast") === true && !enabled) {
			enabled = true;
			await writeGlobalEnabled(true);
		}

		setStatus(ctx, enabled);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled) return;

		const provider = ctx.model?.provider;
		if (provider !== "openai" && provider !== "openai-codex") return;

		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

		return {
			...(event.payload as JsonObject),
			service_tier: "priority",
		};
	});

	pi.on("model_select", (_event, ctx) => setStatus(ctx, enabled));
}
