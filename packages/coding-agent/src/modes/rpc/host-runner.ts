/**
 * One host request, performed: ensure a daemon, report one, stop one, or hand one off.
 *
 * This is the whole behaviour behind `senpi host` - and behind the launchers that call the same
 * entry point in-process - separated from the command line that expresses it. Every request answers
 * with a JSON payload plus the exit code that payload means, so a CLI, a desktop and a task runner
 * report the same outcome with the same vocabulary:
 *
 *     0  the request happened            3  refused: a running host this client may not act on,
 *     4  no host is better than this one     an unreachable socket, or a stop that would end
 *        one (fallback policy)               somebody else's work
 *
 * The refusals are the point. One machine-wide daemon holds every client's sessions, so a client
 * that cannot get what it wants must SAY so and leave the running host alone (I1) - never stop it,
 * never bind a second host over its socket. `decideHostAction`, `ensureHost`, `stopHost` and
 * `handoffHost` already enforce that; this module only gives their outcomes a machine-readable shape.
 */
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import { daemonEnvKeys, daemonEnvOverrides, writeDaemonEnvKeys } from "./host-daemon-env.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import {
	decideHostAction,
	HOST_PROTOCOL_VERSION,
	type HostDecisionClient,
	type HostDecisionPolicy,
	HostEnsureRefusedError,
	type HostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./host-decision.ts";
import { type EnsuredHost, ensureHost } from "./host-ensure.ts";
import { type HandoffRefusal, handoffHost } from "./host-handoff.ts";
import type { ResolvedHostLaunchSpec } from "./host-launch-spec.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { hostSummary, readHostStatus, readSessionCounts } from "./host-status.ts";
import { stopHost } from "./host-stop.ts";

export const HOST_EXIT_OK = 0;
export const HOST_EXIT_ERROR = 1;
export const HOST_EXIT_USAGE = 2;
export const HOST_EXIT_REFUSED = 3;
export const HOST_EXIT_FALLBACK = 4;

const PROBE_TIMEOUT_MS = 10_000;

/** Which daemon a request is about: the endpoint, and the agent directory holding its state. */
export interface HostTarget {
	readonly socket: string;
	readonly agentDir: string;
}

export type HostRequest =
	| {
			readonly action: "ensure";
			readonly target: HostTarget;
			readonly spec: ResolvedHostLaunchSpec;
			readonly policy: HostDecisionPolicy;
	  }
	| { readonly action: "status"; readonly target: HostTarget; readonly includeWorkers: boolean }
	| { readonly action: "stop"; readonly target: HostTarget; readonly drain: boolean; readonly force: boolean }
	| { readonly action: "handoff"; readonly target: HostTarget; readonly spec: ResolvedHostLaunchSpec };

/** One JSON line and the exit code it means. */
export interface HostOutcome {
	readonly exitCode: number;
	readonly payload: Record<string, unknown>;
}

export async function runHostRequest(request: HostRequest): Promise<HostOutcome> {
	switch (request.action) {
		case "ensure":
			return ensureOutcome(request.target, request.spec, request.policy);
		case "status":
			return statusOutcome(request.target, request.includeWorkers);
		case "stop":
			return stopOutcome(request.target, request.drain, request.force);
		case "handoff":
			return handoffOutcome(request.target, request.spec);
		default:
			return assertNever(request);
	}
}

async function ensureOutcome(
	target: HostTarget,
	spec: ResolvedHostLaunchSpec,
	policy: HostDecisionPolicy,
): Promise<HostOutcome> {
	const before = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	if (policy === "fallback") {
		// `fallback` is the caller saying it can live without a host. The decision is made HERE
		// because an ensure always produces a host or fails: it has no fallback answer of its own.
		const decision = decideHostAction(decisionClient(), before, "fallback");
		if (decision.action === "fallback") {
			return refusal("fallback", before, { reason: decision.reason, socket: target.socket });
		}
	}
	let ensured: EnsuredHost;
	try {
		ensured = await ensureHost({
			socket: target.socket,
			agentDir: target.agentDir,
			hostArgs: spec.hostArgs,
			env: daemonEnvOverrides(process.env, spec.env),
			policy: spec.policy,
			upgrade: policy === "upgrade" ? "if-engine-differs" : "never",
		});
	} catch (error: unknown) {
		if (!(error instanceof HostEnsureRefusedError)) throw error;
		return refusal("refuse", before, { reason: error.reason, socket: target.socket });
	}
	const host = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	// Only a spawn grants an environment; a reuse inherited whatever the client that started it did.
	if (!ensured.reused) await recordEnvScope(target, spec);
	return {
		exitCode: HOST_EXIT_OK,
		payload: {
			action: ensureAction(ensured.reused, before, host),
			...identityPayload(target.socket, ensured.pid, host),
			reused: ensured.reused,
		},
	};
}

/**
 * What an ensure DID. A handoff and a fresh start both report `reused: false`, so the instance id is
 * what tells them apart: a handoff replaced the process behind a socket somebody was already serving.
 */
function ensureAction(
	reused: boolean,
	before: HostProtocolInfo | undefined,
	after: HostProtocolInfo | undefined,
): string {
	if (reused) return "reuse";
	return before !== undefined && before.instanceId !== after?.instanceId ? "handoff" : "start";
}

async function statusOutcome(target: HostTarget, includeWorkers: boolean): Promise<HostOutcome> {
	const status = await readHostStatus({ socket: target.socket, agentDir: target.agentDir, includeWorkers });
	return { exitCode: status.reachable ? HOST_EXIT_OK : HOST_EXIT_REFUSED, payload: { ...status } };
}

/**
 * A hard stop ends every session the daemon holds, including the ones other clients are attached to,
 * so it is gated on the host's own count and refuses with those counts rather than a bare "busy".
 * A DRAIN ends no work - the host stops accepting and leaves when it is empty - so it is never gated.
 */
async function stopOutcome(target: HostTarget, drain: boolean, force: boolean): Promise<HostOutcome> {
	const host = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	const sessions = await readSessionCounts(target.socket, true);
	const occupied = sessions.foreign_attached + sessions.foreign_retained > 0;
	if (!drain && !force && occupied) {
		return refusal("refuse", host, { reason: "sessions_live", socket: target.socket, sessions });
	}
	const result = await stopHost({ socket: target.socket, agentDir: target.agentDir, drain, force });
	if (result.action === "refuse") {
		return refusal("refuse", host, { reason: result.reason, socket: target.socket, sessions });
	}
	return {
		exitCode: HOST_EXIT_OK,
		payload: { action: result.action, socket: target.socket, pid: result.pid, sessions },
	};
}

async function handoffOutcome(target: HostTarget, spec: ResolvedHostLaunchSpec): Promise<HostOutcome> {
	const before = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	const result = await handoffHost({
		socket: target.socket,
		agentDir: target.agentDir,
		hostArgs: spec.hostArgs,
		env: daemonEnvOverrides(process.env, spec.env),
		policy: spec.policy,
	});
	if (result.action === "refuse") {
		return refusal("refuse", before, {
			reason: upgradeRefusal(result.reason),
			socket: target.socket,
			detail: result.reason,
			upgradeable: result.upgradeable,
		});
	}
	await recordEnvScope(target, spec);
	const host = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	return {
		exitCode: HOST_EXIT_OK,
		payload: { action: "handoff", ...identityPayload(target.socket, result.pid, host), reused: false },
	};
}

/**
 * A host that cannot drain and a platform that cannot hand off are one answer to the caller: this
 * build may not replace the running generation. The refusal that produced it stays in `detail`.
 */
function upgradeRefusal(reason: HandoffRefusal): string {
	return reason === "handoff_unsupported" ? "upgrade_unsupported" : reason;
}

function identityPayload(socket: string, pid: number, host: HostProtocolInfo | undefined): Record<string, unknown> {
	return {
		socket,
		pid,
		instanceId: host?.instanceId ?? null,
		generation: host?.generation ?? null,
		engineVersion: host?.engineVersion ?? null,
		engineOrdinal: host?.engineOrdinal ?? null,
		capabilities: host?.capabilities ?? [],
		launchProfileId: host?.launch_profile?.profile_id ?? null,
		upgradeable: decideHostAction(decisionClient(), host, "upgrade").upgradeable,
	};
}

/**
 * The two ways a request ends without acting, and the exit codes they mean: a `refuse` leaves a
 * running host alone (3), a `fallback` says no host is better than this one (4).
 */
function refusal(
	kind: "refuse" | "fallback",
	host: HostProtocolInfo | undefined,
	body: { readonly reason: string } & Record<string, unknown>,
): HostOutcome {
	return {
		exitCode: kind === "refuse" ? HOST_EXIT_REFUSED : HOST_EXIT_FALLBACK,
		payload: { action: kind, ...body, host: hostSummary(host) },
	};
}

async function recordEnvScope(target: HostTarget, spec: ResolvedHostLaunchSpec): Promise<void> {
	const paths = createHostDaemonPaths({ socket: target.socket, agentDir: target.agentDir });
	await writeDaemonEnvKeys(paths, daemonEnvKeys(process.env, spec.env));
}

/**
 * This build as a client, WITHOUT a launch profile: the request's own `ensureHost` decides whether a
 * handoff may happen, from the profile it would launch. What is asked here is only what any client
 * can answer without one - is the running host usable, and could it be handed off from at all.
 */
function decisionClient(): HostDecisionClient {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		requiredCapabilities: REQUIRED_HOST_CAPABILITIES,
		identity: engineBuildIdentity(),
		startedByUs: false,
		platform: process.platform,
	};
}

function assertNever(value: never): never {
	throw new Error(`unreachable host request: ${JSON.stringify(value)}`);
}
