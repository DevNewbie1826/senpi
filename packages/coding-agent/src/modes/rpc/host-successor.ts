/**
 * Bringing up the SUCCESSOR generation: where it binds, what it is launched with, and the single
 * observation that proves it took the socket over.
 *
 * The successor binds `<public>.next-<gen>` - never the live public path, which it has no right to
 * unlink - and renames its own entry over the public path only while that path still holds the exact
 * socket this handoff was decided against (`--replace <dev>:<ino>`). Its own answer ON THE PUBLIC
 * SOCKET, reporting an `instanceId` different from the generation being replaced, is the only proof
 * the rename landed; an exit instead means it refused to replace a path that changed underneath and
 * left both sockets alone. The predecessor is asked to drain only AFTER that proof and after the
 * successor is registered - whether it may be asked at all was decided in `host-handoff.ts`, which
 * proved the owner and checked that the running host advertises it can survive the signal.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { ENV_AGENT_DIR } from "../../config.ts";
import { waitForStartTime } from "../app-server/daemon/process.ts";
import { RPC_CLIENT_CAPABILITIES_ENV } from "./custom-capability.ts";
import { HOST_DAEMON_DIR_ENV, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { writeHostRegistration } from "./host-daemon-registration.ts";
import { readHostSettings, writeHostSettings } from "./host-daemon-state.ts";
import type { HandoffHostOptions, HandoffRefusal, HandoffResult } from "./host-handoff.ts";
import { defaultHostLaunch, PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "./host-lifecycle.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";
import { signalGeneration } from "./host-stop.ts";
import { HOST_GENERATION_ENV, HOST_INSTANCE_ID_ENV, hostLaunchProfile } from "./protocol-identity.ts";
import {
	generationBindPath,
	MAX_SOCKET_PATH_BYTES,
	type SocketFileIdentity,
	statSocketIdentity,
} from "./socket-ownership.ts";

/** How long the successor has to answer on the PUBLIC socket before the handoff is abandoned. */
const DEFAULT_HANDOFF_READINESS_MS = 30_000;

export async function startSuccessor(context: {
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
