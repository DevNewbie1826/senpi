/**
 * WHICH environment variables a daemon this machine starts is allowed to see.
 *
 * A shared daemon outlives the shell that started it and serves every client on the machine, so
 * "whatever the ensuring process happened to have" is the wrong scope for its environment: a CI
 * token, a database URL or a one-off secret exported in one terminal would be inherited by a
 * process that then answers other clients for hours. The daemon therefore receives an ALLOWLIST -
 * the names a coding agent genuinely needs (the shell's own wiring, the locale, the brand's own
 * `SENPI_`/`OMO_`/`PI_` lane, proxy settings and provider credentials) - plus whatever the launch
 * spec states explicitly. Everything else is dropped, by NAME, without ever reading its value.
 *
 * The allowlist is matched case-sensitively on POSIX, where `PATH` and `Path` are two different
 * variables, and case-insensitively on win32, where they are one - and where a daemon stripped of
 * `SystemRoot`, `ComSpec` or `PATHEXT` cannot spawn a child at all.
 */
import { join } from "node:path";
import type { HostDaemonPaths } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined, writeStateFile } from "./host-daemon-state.ts";

/** Names a daemon may inherit from the process that ensures it. */
const ALLOWED_ENV_NAMES = [
	/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG)$/u,
	/^(LC|XDG)_/u,
	/^(SENPI|OMO|PI)_/u,
	/^(HTTPS?_PROXY|NO_PROXY)$/u,
	/^[A-Z0-9_]+_API_KEY$/u,
	/^(ANTHROPIC|OPENAI|GOOGLE|GEMINI|AZURE|AWS|OPENROUTER|XAI|MISTRAL|DEEPSEEK|GROQ|CEREBRAS|MINIMAX)_/u,
] as const;

/**
 * win32 wiring no process can run without. Dropping `SystemRoot` alone makes every subsequent
 * `spawn` fail, so these are allowed in addition to the list above on that platform only.
 */
const WINDOWS_SYSTEM_ENV_NAMES = new Set([
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMDATA",
	"HOMEDRIVE",
	"HOMEPATH",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
]);

export function daemonEnvIsAllowed(name: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "win32") return ALLOWED_ENV_NAMES.some((pattern) => pattern.test(name));
	const upper = name.toUpperCase();
	return WINDOWS_SYSTEM_ENV_NAMES.has(upper) || ALLOWED_ENV_NAMES.some((pattern) => pattern.test(upper));
}

/**
 * The `env` an ensure hands the daemon: every name it may NOT inherit mapped to `null` (which
 * removes it), then the launch spec's own entries. Values are never inspected - a variable is kept
 * or dropped by its name alone - and the spec's entries win, because they were stated on purpose.
 */
export function daemonEnvOverrides(
	processEnv: Readonly<Record<string, string | undefined>>,
	specEnv: Readonly<Record<string, string>> = {},
	platform: NodeJS.Platform = process.platform,
): Record<string, string | null> {
	const overrides: Record<string, string | null> = {};
	for (const name of Object.keys(processEnv)) {
		if (!daemonEnvIsAllowed(name, platform)) overrides[name] = null;
	}
	for (const [name, value] of Object.entries(specEnv)) overrides[name] = value;
	return overrides;
}

/** The names the daemon ends up with, sorted. Names only: a value never leaves this process. */
export function daemonEnvKeys(
	processEnv: Readonly<Record<string, string | undefined>>,
	specEnv: Readonly<Record<string, string>> = {},
	platform: NodeJS.Platform = process.platform,
): string[] {
	const kept = Object.keys(processEnv).filter((name) => daemonEnvIsAllowed(name, platform));
	return [...new Set([...kept, ...Object.keys(specEnv)])].sort();
}

/**
 * Records the granted NAMES beside the daemon's other state, so `senpi host status` can report the
 * scope a running daemon was started with. Written by whichever client spawned the generation;
 * absent for a daemon started by a client that predates this file, which reads as "unknown scope".
 */
export async function writeDaemonEnvKeys(paths: HostDaemonPaths, keys: readonly string[]): Promise<void> {
	await writeStateFile(daemonEnvKeysFile(paths), { env_keys: keys });
}

export async function readDaemonEnvKeys(paths: HostDaemonPaths): Promise<string[]> {
	const parsed = parseJson(await readFileOrUndefined(daemonEnvKeysFile(paths)));
	const keys = parsed?.env_keys;
	if (!Array.isArray(keys)) return [];
	return keys.filter((key): key is string => typeof key === "string");
}

function daemonEnvKeysFile(paths: HostDaemonPaths): string {
	return join(paths.dir, "env-keys.json");
}
