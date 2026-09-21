/**
 * What a client can observe about the daemon on one socket, in one record.
 *
 * Everything that describes the RUNNING host comes from the host's own answers - `get_protocol_info`
 * for identity, `list_sessions` for occupancy - because files describe the past and the socket
 * describes the present. Everything that describes the DAEMON DIRECTORY (which generations exist,
 * which environment scope the last ensure granted) comes from disk, because a generation that no
 * longer answers is exactly what an operator is looking for when they ask.
 *
 * A socket nobody serves is not an error here: `reachable: false` with the same field set is the
 * answer, so a caller parses one shape either way and branches on one boolean.
 */
import { readDaemonEnvKeys } from "./host-daemon-env.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import type { HostProtocolInfo } from "./host-decision.ts";
import { type HostGenerationRow, pruneDeadGenerations, readGenerationRows } from "./host-generations.ts";
import { probeProtocolInfo, requestOnSocket } from "./host-probe.ts";
import { type HostProcessMetrics, readHostProcessMetrics } from "./host-process-metrics.ts";
import type { RpcLaunchProfile } from "./rpc-types.ts";

const STATUS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Sessions the host reports. `foreign_*` is the same count from the point of view of a client that
 * holds none of them itself: for the CLI every session belongs to somebody else, which is exactly
 * why a hard stop is gated on it.
 */
export interface HostSessionCounts {
	readonly total: number;
	readonly interactive: number;
	readonly worker: number;
	/** Open at zero attachments: retained across a disconnect, still holding its transcript. */
	readonly retained: number;
	readonly foreign_attached: number;
	readonly foreign_retained: number;
}

export type { HostGenerationRow } from "./host-generations.ts";

export interface HostStatusReport {
	readonly reachable: boolean;
	readonly socket: string;
	readonly pid: number | null;
	readonly instanceId: string | null;
	readonly generation: number | null;
	readonly engineVersion: string | null;
	readonly capabilities: readonly string[];
	readonly launchProfile: RpcLaunchProfile | null;
	readonly sessions: HostSessionCounts;
	readonly zombies: number | null;
	readonly rss_mb: number | null;
	readonly open_fds: number | null;
	/** Environment NAMES the daemon was granted, never values. */
	readonly env_keys: readonly string[];
	readonly generations: readonly HostGenerationRow[];
}

export interface HostStatusOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Ask the host to include `kind: "worker"` rows, exactly as `list_sessions` defines the flag. */
	readonly includeWorkers?: boolean;
}

export async function readHostStatus(options: HostStatusOptions): Promise<HostStatusReport> {
	const paths = createHostDaemonPaths({
		socket: options.socket,
		...(options.agentDir ? { agentDir: options.agentDir } : {}),
	});
	const host = await probeProtocolInfo(options.socket, STATUS_PROBE_TIMEOUT_MS);
	// Reading the directory is also when it is cleaned: an operator asking what runs here must not
	// be shown generations that ended, and the next reader must get the same answer.
	await pruneDeadGenerations(paths);
	const generations = await readGenerationRows(paths);
	const current = generations.find((row) => row.current);
	const metrics = current ? await readHostProcessMetrics(current.pid) : UNOBSERVED_METRICS;
	return {
		reachable: host !== undefined,
		socket: options.socket,
		pid: current?.pid ?? null,
		instanceId: host?.instanceId ?? current?.instanceId ?? null,
		generation: host?.generation ?? current?.generation ?? null,
		engineVersion: host?.engineVersion ?? current?.engineVersion ?? null,
		capabilities: host?.capabilities ?? [],
		launchProfile: host?.launch_profile ?? null,
		sessions: await readSessionCounts(options.socket, options.includeWorkers === true),
		zombies: metrics.zombies,
		rss_mb: metrics.rss_mb,
		open_fds: metrics.open_fds,
		env_keys: await readDaemonEnvKeys(paths),
		generations,
	};
}

/**
 * The occupancy a stop decision is made on. A host that does not answer holds nothing a client can
 * see, and an empty count is what lets a stop proceed against a socket nobody serves.
 */
export async function readSessionCounts(socket: string, includeWorkers: boolean): Promise<HostSessionCounts> {
	const reply = await requestOnSocket(
		socket,
		{ type: "list_sessions", ...(includeWorkers ? { include_workers: true } : {}) },
		STATUS_PROBE_TIMEOUT_MS,
	);
	const rows = sessionRows(reply);
	const attached = rows.filter((row) => row.attachments > 0).length;
	const retained = rows.length - attached;
	return {
		total: rows.length,
		interactive: rows.filter((row) => row.kind !== "worker").length,
		worker: rows.filter((row) => row.kind === "worker").length,
		retained,
		foreign_attached: attached,
		foreign_retained: retained,
	};
}

/** Identity fields of a probed host, for the `host` field of a refusal. */
export function hostSummary(host: HostProtocolInfo | undefined): Record<string, unknown> | null {
	if (host === undefined) return null;
	return {
		protocolVersion: host.protocolVersion,
		serverVersion: host.serverVersion,
		capabilities: host.capabilities,
		instanceId: host.instanceId ?? null,
		generation: host.generation ?? null,
		engineVersion: host.engineVersion ?? null,
		launchProfileId: host.launch_profile?.profile_id ?? null,
	};
}

const UNOBSERVED_METRICS: HostProcessMetrics = { rss_mb: null, open_fds: null, zombies: null };

interface SessionRow {
	readonly kind: string;
	readonly attachments: number;
}

function sessionRows(reply: unknown): readonly SessionRow[] {
	if (!isRecord(reply) || !Array.isArray(reply.sessions)) return [];
	return reply.sessions.flatMap((entry: unknown) => {
		if (!isRecord(entry)) return [];
		return [
			{
				kind: typeof entry.kind === "string" ? entry.kind : "interactive",
				attachments: typeof entry.attachments === "number" ? entry.attachments : 0,
			},
		];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
