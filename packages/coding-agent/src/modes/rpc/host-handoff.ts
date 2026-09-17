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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { ENV_AGENT_DIR } from "../../config.ts";
import { waitForStartTime } from "../app-server/daemon/process.ts";
import { RPC_CLIENT_CAPABILITIES_ENV } from "./custom-capability.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	HOST_DAEMON_DIR_ENV,
	type HostDaemonPaths,
	provenOwner,
	readHostRegistration,
	readHostSettings,
	writeHostRegistration,
	writeHostSettings,
} from "./host-daemon-state.ts";
import { GENERATION_HANDOFF_CAPABILITY, type HostProtocolInfo } from "./host-decision.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS, type HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { signalGeneration } from "./host-stop.ts";
import { HOST_GENERATION_ENV, HOST_INSTANCE_ID_ENV, hostLaunchProfile } from "./protocol-identity.ts";
import {
	generationBindPath,
	MAX_SOCKET_PATH_BYTES,
	type SocketFileIdentity,
	statSocketIdentity,
} from "./socket-ownership.ts";

const DEFAULT_HANDOFF_READINESS_MS = 30_000;

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

async function startSuccessor(context: {
	options: HandoffHostOptions;
	paths: HostDaemonPaths;
	host: HostProtocolInfo;
	owner: { pid: number; processStartTime: string; instanceId: string };
}): Promise<HandoffResult> {
	const { options, paths, host, owner } = context;
	const generation = (host.generation ?? 0) + 1;
	// The successor's identity, chosen here so its generation directory holds its settings before it
	// boots and the pointer can name it the instant it answers on the public socket.
	const instanceId = randomUUID();
	const bindSocket = generationBindPath(options.socket, generation);
	if (Buffer.byteLength(bindSocket) > MAX_SOCKET_PATH_BYTES) {
		return { action: "refuse", reason: "socket_path_too_long", upgradeable: true, detail: bindSocket };
	}
	const replaced = await statSocketIdentity(options.socket);
	if (!replaced) return { action: "refuse", reason: "socket_replaced", upgradeable: true };
	// A handoff replaces the ENGINE, not the operator's lifecycle policy: the successor inherits
	// what the running generation was started with unless this caller states its own.
	const running = await readHostSettings(paths);
	await writeHostSettings(paths, {
		socket: options.socket,
		capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
		coldStart: options.policy?.coldStart ?? running?.coldStart ?? "transient",
		idleExitMs: options.policy?.idleExitMs ?? running?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		generation,
		instanceId,
	});
	await options._test?.beforeSpawn?.();
	const argv = [
		"--socket",
		options.socket,
		"--bind",
		bindSocket,
		"--replace",
		`${replaced.dev}:${replaced.ino}`,
		...(options.hostArgs ?? []),
	];
	const launch = options._test?.launch?.(argv) ?? defaultHostLaunch(argv);
	const stderr = await open(paths.stderrLog, "a", 0o600);
	const child = spawn(launch.command, [...launch.args], {
		detached: true,
		windowsHide: true,
		env: successorEnv(options, { paths, generation, instanceId }),
		stdio: ["ignore", "ignore", stderr.fd],
	});
	await stderr.close();
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		if (child.pid === undefined) throw new Error("failed to spawn the successor generation");
		const answer = await awaitSuccessor(options, host, exited);
		if (!answer) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			return { action: "refuse", reason: await abortReason(options.socket, replaced), upgradeable: true };
		}
		const processStartTime = (await waitForStartTime(child.pid, 10_000).catch(() => undefined)) ?? null;
		// The pointer moves to the successor only now: until the rename landed, the generation the
		// clients reach is still the predecessor, and the pointer has to name whoever owns the socket.
		await writeHostRegistration(paths, {
			record: { pid: child.pid, processStartTime },
			socket: options.socket,
			instanceId,
			generation,
			launchProfileId: hostLaunchProfile(
				["--mode", "rpc", "--multi-session", ...(options.hostArgs ?? [])],
				process.cwd(),
			).profile_id,
		});
		child.unref();
		// The successor owns the socket now: the predecessor may drain. SIGUSR1 is sent only here,
		// to a pid the record proved and a host that advertised it can survive the signal. A
		// predecessor that exited on its own in the meantime is already drained, and the handoff it
		// was being asked to make room for has already happened.
		signalGeneration(owner.pid, "SIGUSR1");
		return {
			action: "handoff",
			pid: child.pid,
			socket: options.socket,
			generation: answer.generation ?? generation,
			instanceId: answer.instanceId ?? "",
		};
	} catch (cause) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		return {
			action: "refuse",
			reason: "successor_unavailable",
			upgradeable: true,
			detail: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

/**
 * The successor's own answer on the PUBLIC socket is the only proof the rename landed: it
 * reports a different `instanceId` than the generation being replaced. An exit instead means
 * the successor refused to replace the path (a foreign socket, a live bind path) and left it alone.
 */
async function awaitSuccessor(
	options: HandoffHostOptions,
	previous: HostProtocolInfo,
	exited: Promise<void>,
): Promise<HostProtocolInfo | undefined> {
	const deadline = Date.now() + (options._test?.readinessTimeoutMs ?? DEFAULT_HANDOFF_READINESS_MS);
	let childGone = false;
	void exited.then(() => {
		childGone = true;
	});
	while (Date.now() <= deadline) {
		const answer = await probeProtocolInfo(options.socket, 2_000);
		if (answer && answer.instanceId !== undefined && answer.instanceId !== previous.instanceId) return answer;
		if (childGone) return undefined;
		await delay(50);
	}
	return undefined;
}

/**
 * What actually stopped the handoff, read from the endpoint rather than guessed: a public path
 * that no longer holds the socket this handoff was decided against was taken by somebody else,
 * and the successor correctly refused to rename over it.
 */
async function abortReason(socket: string, replaced: SocketFileIdentity): Promise<HandoffRefusal> {
	const current = await statSocketIdentity(socket).catch(() => undefined);
	return current === undefined || current.dev !== replaced.dev || current.ino !== replaced.ino
		? "socket_replaced"
		: "successor_unavailable";
}

function successorEnv(
	options: HandoffHostOptions,
	successor: { readonly paths: HostDaemonPaths; readonly generation: number; readonly instanceId: string },
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[HOST_GENERATION_ENV]: String(successor.generation),
		// Always SET, never inherited: a handoff completes exactly when the instance id on the socket
		// changes, so a successor that inherited the predecessor's id could never be seen to arrive.
		[HOST_INSTANCE_ID_ENV]: successor.instanceId,
		[HOST_DAEMON_DIR_ENV]: successor.paths.dir,
		[RPC_CLIENT_CAPABILITIES_ENV]: PINNED_HOST_CLIENT_CAPABILITIES.join(","),
		...(options.agentDir ? { [ENV_AGENT_DIR]: options.agentDir } : {}),
	};
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (value === null) delete env[key];
		else env[key] = value;
	}
	return env;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
