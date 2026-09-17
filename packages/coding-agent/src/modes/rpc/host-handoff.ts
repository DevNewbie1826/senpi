/**
 * Replacing a running daemon without ending the work it is doing.
 *
 * An upgrade cannot mean "kill the host and start a newer one": one machine-wide daemon
 * holds every client's sessions, so that is a data-loss operation dressed as a version
 * bump. A GENERATION HANDOFF replaces the process while the work continues:
 *
 *   1. the successor binds `<public>.next-<gen>` - never the live public path, which it
 *      has no right to unlink - and only renames its own entry over the public path once
 *      its host answers, and only while that path still holds the exact socket this
 *      handoff was decided against (`--replace <dev>:<ino>`);
 *   2. the predecessor is then asked to DRAIN with SIGUSR1: it stops accepting, keeps
 *      every connection it is already proxying, parks each retained session as its turn
 *      settles, and exits through its ordinary idle path;
 *   3. clients that arrive in between reach whichever generation owns the path at that
 *      instant - both are alive and serving.
 *
 * Two guards make this safe rather than merely clever. SIGUSR1 has a DEFAULT DISPOSITION OF
 * TERMINATE, so a host that does not advertise `generation_handoff` is never signalled - it
 * would die, taking its sessions with it. And a host whose pidfile identity cannot be proven
 * is never signalled either (I1), because "the process at this pid" is not evidence.
 *
 * win32 has neither a renameable named pipe nor SIGUSR1, so every entry point here refuses
 * with `upgrade_unsupported`; upgrades there apply after a drain-stop or an idle exit.
 */
import { createDaemonDirectories, createHostDaemonPaths } from "./host-daemon-paths.ts";
import { provenOwner, readHostRegistration } from "./host-daemon-registration.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "./host-decision.ts";
import type { HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { startSuccessor } from "./host-successor.ts";

export interface HandoffHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Extra CLI arguments the successor's host child is launched with (provider pinning, extensions). */
	readonly hostArgs?: readonly string[];
	/** Environment for the successor; a `null` value removes an inherited variable. */
	readonly env?: Readonly<Record<string, string | null>>;
	readonly policy?: HostLifecyclePolicyInput;
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		/** Builds the spawnable command from supervisor argv; tests point it at the source entry. */
		readonly launch?: (args: readonly string[]) => { command: string; args: readonly string[] };
		/** Runs after the public socket identity is captured and before the successor is spawned. */
		readonly beforeSpawn?: () => Promise<void>;
		readonly platform?: NodeJS.Platform;
	};
}

/** Why a handoff did not happen. Every one of them leaves the running host untouched. */
export type HandoffRefusal =
	/** Nothing is serving the socket: there is no generation to hand off from. */
	| "no_host"
	/** The running host predates the drain handler; signalling it would kill it. */
	| "handoff_unsupported"
	/** win32: a named pipe can be neither renamed nor drained. */
	| "upgrade_unsupported"
	/** The pidfile cannot prove which process serves this socket, so it may not be signalled. */
	| "unknown_owner"
	/** The public socket stopped being the one this handoff was decided against. */
	| "socket_replaced"
	/** `<public>.next-<gen>` would exceed the platform's socket path limit. */
	| "socket_path_too_long"
	/** The successor never answered on the public socket; it was stopped and nothing was replaced. */
	| "successor_unavailable";

export type HandoffResult =
	| {
			readonly action: "handoff";
			readonly pid: number;
			readonly socket: string;
			readonly generation: number;
			readonly instanceId: string;
	  }
	| {
			readonly action: "refuse";
			readonly reason: HandoffRefusal;
			readonly upgradeable: boolean;
			readonly detail?: string;
	  };

/**
 * Hands the socket to a new generation of this build. Forced by design: the caller decides
 * whether an upgrade is warranted (`decideHostAction`); this performs the one it asked for.
 */
export async function handoffHost(options: HandoffHostOptions): Promise<HandoffResult> {
	const platform = options._test?.platform ?? process.platform;
	if (platform === "win32") return { action: "refuse", reason: "upgrade_unsupported", upgradeable: false };
	const paths = createHostDaemonPaths({
		socket: options.socket,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	await createDaemonDirectories(paths);
	const host = await probeProtocolInfo(options.socket, 10_000);
	if (!host) return { action: "refuse", reason: "no_host", upgradeable: false };
	if (!host.capabilities.includes(GENERATION_HANDOFF_CAPABILITY)) {
		return { action: "refuse", reason: "handoff_unsupported", upgradeable: false };
	}
	const registered = await readHostRegistration(paths);
	const owner = await provenOwner(registered, options.socket);
	if (!owner) return { action: "refuse", reason: "unknown_owner", upgradeable: true };
	return startSuccessor({ options, paths, host, owner });
}
