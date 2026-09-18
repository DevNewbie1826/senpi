/**
 * `senpi host ensure|status|stop|handoff` - the one command every client calls to get a daemon.
 *
 * The contract is machine-first, because every caller is a program: EXACTLY ONE JSON line on stdout
 * and nothing else, an exit code that classifies the outcome without parsing that line, and
 * diagnostics on stderr where they cannot corrupt either.
 *
 *     0  it happened        2  the command line or the launch spec is unusable
 *     1  it failed          3  refused (see `reason`)              4  fallback: no host is better
 *
 * The line is written with a synchronous `write`, then the process exits with the code: a
 * `console.log` to a pipe is asynchronous, and `process.exit` would truncate the one thing the
 * caller is parsing.
 *
 * The launch spec is a FILE PATH and never stdin or an argv blob - the file's owner and mode are
 * what make it trustworthy, and its directory is what extension paths resolve against
 * (`host-launch-spec.ts`). The environment the daemon is spawned with is an allowlist of NAMES
 * (`host-daemon-env.ts`), never this process's whole environment.
 */
import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { APP_NAME, getAgentDir } from "../config.ts";
import { envValue } from "../core/brand.ts";
import type { HostDecisionPolicy } from "../modes/rpc/host-decision.ts";
import {
	DEFAULT_HOST_LAUNCH_SPEC,
	HostLaunchSpecError,
	loadHostLaunchSpec,
	type ResolvedHostLaunchSpec,
} from "../modes/rpc/host-launch-spec.ts";
import {
	HOST_EXIT_ERROR,
	HOST_EXIT_USAGE,
	type HostRequest,
	type HostTarget,
	runHostRequest,
} from "../modes/rpc/host-runner.ts";

const SUBCOMMANDS = ["ensure", "status", "stop", "handoff"] as const;
type HostSubcommand = (typeof SUBCOMMANDS)[number];

const POLICIES = ["upgrade", "fallback", "never"] as const;

const USAGE = `usage: ${APP_NAME} host <ensure|status|stop|handoff> [options]

  ensure   [--launch-spec <file>] [--policy upgrade|fallback|never] [--socket <path>]
  status   [--include-workers] [--socket <path>]
  stop     [--drain] [--force] [--socket <path>]
  handoff  [--launch-spec <file>] [--socket <path>]

  --json   accepted for symmetry; the answer is always one JSON line on stdout`;

interface ParsedHostArgs {
	readonly subcommand: HostSubcommand;
	readonly specPath?: string;
	readonly policy: HostDecisionPolicy;
	readonly socket?: string;
	readonly includeWorkers: boolean;
	readonly drain: boolean;
	readonly force: boolean;
}

/**
 * Runs one `host` invocation and returns the exit code it means, having written its single JSON
 * line. Exported for the launchers that drive the same surface without a shell.
 */
export async function runHostCommand(args: readonly string[]): Promise<number> {
	const parsed = parseHostArgs(args);
	if (typeof parsed === "string") {
		process.stderr.write(`${parsed}\n${USAGE}\n`);
		return HOST_EXIT_USAGE;
	}
	try {
		const outcome = await runHostRequest(await hostRequest(parsed));
		emit(outcome.payload);
		return outcome.exitCode;
	} catch (error: unknown) {
		if (error instanceof HostLaunchSpecError) {
			emit({ action: "error", reason: error.reason, detail: error.detail });
			return HOST_EXIT_USAGE;
		}
		emit({ action: "error", reason: "host_error", detail: error instanceof Error ? error.message : String(error) });
		return HOST_EXIT_ERROR;
	}
}

async function hostRequest(parsed: ParsedHostArgs): Promise<HostRequest> {
	const agentDir = getAgentDir();
	const target: HostTarget = { socket: resolveHostSocket(parsed.socket, agentDir), agentDir };
	switch (parsed.subcommand) {
		case "ensure":
			return { action: "ensure", target, spec: await launchSpec(parsed.specPath), policy: parsed.policy };
		case "status":
			return { action: "status", target, includeWorkers: parsed.includeWorkers };
		case "stop":
			return { action: "stop", target, drain: parsed.drain, force: parsed.force };
		case "handoff":
			return { action: "handoff", target, spec: await launchSpec(parsed.specPath) };
		default:
			return assertNever(parsed.subcommand);
	}
}

function launchSpec(specPath: string | undefined): Promise<ResolvedHostLaunchSpec> | ResolvedHostLaunchSpec {
	return specPath === undefined ? DEFAULT_HOST_LAUNCH_SPEC : loadHostLaunchSpec(specPath);
}

/** The endpoint this client would reach: the one it was given, the branded override, or the default. */
function resolveHostSocket(explicit: string | undefined, agentDir: string): string {
	return explicit ?? envValue("RPC_SOCKET") ?? resolve(agentDir, "rpc", "rpc.sock");
}

/** Parses the command line, or answers with the message that says why it could not. */
export function parseHostArgs(args: readonly string[]): ParsedHostArgs | string {
	const [subcommand, ...rest] = args;
	if (subcommand === undefined || !isSubcommand(subcommand)) {
		return `Error: unknown host command "${subcommand ?? ""}".`;
	}
	let specPath: string | undefined;
	let policy: HostDecisionPolicy = "upgrade";
	let socket: string | undefined;
	let includeWorkers = false;
	let drain = false;
	let force = false;
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (flag === "--json") continue;
		if (flag === "--include-workers") {
			includeWorkers = true;
		} else if (flag === "--drain") {
			drain = true;
		} else if (flag === "--force") {
			force = true;
		} else if (flag === "--launch-spec" && value !== undefined) {
			specPath = value;
			index++;
		} else if (flag === "--socket" && value !== undefined) {
			socket = value;
			index++;
		} else if (flag === "--policy" && value !== undefined && isPolicy(value)) {
			policy = value;
			index++;
		} else {
			return `Error: unknown option "${flag}" for "${APP_NAME} host ${subcommand}".`;
		}
	}
	return {
		subcommand,
		...(specPath !== undefined && { specPath }),
		policy,
		...(socket !== undefined && { socket }),
		includeWorkers,
		drain,
		force,
	};
}

/** One line, synchronously, so an exit cannot truncate the answer the caller is parsing. */
function emit(payload: Record<string, unknown>): void {
	writeSync(1, `${JSON.stringify(payload)}\n`);
}

function isSubcommand(value: string): value is HostSubcommand {
	return SUBCOMMANDS.includes(value as HostSubcommand);
}

function isPolicy(value: string): value is HostDecisionPolicy {
	return POLICIES.includes(value as HostDecisionPolicy);
}

function assertNever(value: never): never {
	throw new Error(`unreachable host subcommand: ${JSON.stringify(value)}`);
}
