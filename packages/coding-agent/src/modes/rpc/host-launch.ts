/**
 * How a client re-enters this engine as a lifecycle supervisor.
 *
 * The supervisor owns the public socket and the idle-exit policy; it spawns the committed RPC
 * socket host itself. Both callers that start one - the ordinary ensure and a generation
 * handoff - build the same command here, so a rebranded binary, a compiled standalone and a
 * source checkout all agree on one re-entry route.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../config.ts";
import { CUSTOM_UNSUPPORTED_CAPABILITY, EXTENSION_EVENTS_CAPABILITY } from "./custom-capability.ts";
import { INTERNAL_SUPERVISOR_FLAG } from "./host-lifecycle.ts";

/**
 * Every ensured host starts with this installation-wide profile, independent of the first
 * caller. In particular, extension_events must remain available when a terminal client starts
 * the shared host before the desktop connects.
 */
export const PINNED_HOST_CLIENT_CAPABILITIES = [EXTENSION_EVENTS_CAPABILITY, CUSTOM_UNSUPPORTED_CAPABILITY] as const;

/**
 * Builds the spawnable supervisor command for one supervisor argv
 * (`--socket <public> [--bind <path>] [--replace <dev>:<ino>] [host cli args...]`).
 *
 * A compiled standalone binary cannot re-enter itself through a script path: bun executables
 * always boot their embedded entrypoint and parse the whole argv as CLI arguments, so
 * `host-lifecycle.ts --socket <path>` dies with "Unknown option: --socket" before the host ever
 * answers get_protocol_info. Compiled binaries therefore re-enter through the hidden
 * `--internal-rpc-host-supervisor` route that main() dispatches before argument parsing.
 * Exported for tests.
 */
export function defaultHostLaunch(
	supervisorArgs: readonly string[],
	compiled: boolean = isBunBinary,
): { command: string; args: string[] } {
	if (compiled) return { command: process.execPath, args: [INTERNAL_SUPERVISOR_FLAG, ...supervisorArgs] };
	// Re-enter the running CLI entry through the same hidden route compiled binaries use,
	// rather than pointing at this module's sibling on disk. That sibling exists only in the
	// unbundled tree: bundled, this module IS dist/bundle/cli.js, so the sibling path names
	// dist/bundle/host-lifecycle.js while the bundler emitted dist/bundle/chunks/host-lifecycle.js
	// - and ensure spawned a script that does not exist, so the host died before answering
	// get_protocol_info with nothing written to its stderr log.
	const entry = process.argv[1];
	if (entry !== undefined && entry !== "")
		return { command: process.execPath, args: [...process.execArgv, entry, INTERNAL_SUPERVISOR_FLAG, ...supervisorArgs] };
	return {
		command: process.execPath,
		args: [...process.execArgv, resolveHostLifecycleEntryPath(), ...supervisorArgs],
	};
}

function resolveHostLifecycleEntryPath(): string {
	const modulePath = fileURLToPath(import.meta.url);
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	return resolve(dirname(modulePath), `host-lifecycle${extension}`);
}
