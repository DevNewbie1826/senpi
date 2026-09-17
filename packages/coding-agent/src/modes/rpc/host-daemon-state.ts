/**
 * Where one agent directory's shared RPC host records itself - and who may end it.
 *
 * The pidfile is not just "which process is the host": it is the ONLY evidence a later
 * caller has for invariant I1 (never terminate, signal or replace a host you did not
 * start). Three fields carry that evidence, and each exists because a specific mistake
 * is otherwise unprovable:
 *
 * - `processStartTime` - a pid alone is recycled by the OS, so a stale record would
 *   authorize a signal to an unrelated process.
 * - `writer` - the identity of the process that WROTE the record. Only that process may
 *   stop the host it names; anyone else attaches or refuses.
 * - `socket` - which endpoint the record is about. Today's daemon directory holds one
 *   pidfile per AGENT DIRECTORY, so an ensure for a second socket would otherwise read
 *   the first socket's daemon as its own and stop it. (The per-socket directory layout
 *   that removes the ambiguity entirely is the next change.)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { type DaemonPidFile, parseDaemonPidFile, readProcessStartTime } from "../app-server/daemon/process.ts";

export interface HostDaemonPaths {
	readonly dir: string;
	readonly pidFile: string;
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
}

export function createHostDaemonPaths(agentDir = getAgentDir()): HostDaemonPaths {
	const dir = join(agentDir, "rpc-host-daemon");
	return {
		dir,
		pidFile: join(dir, "host.pid"),
		lockFile: join(dir, "daemon.lock"),
		settingsFile: join(dir, "settings.json"),
		stderrLog: join(dir, "stderr.log"),
	};
}

/** Who wrote a host's pidfile: the process identity a later stop must match to be allowed. */
export interface HostPidFileWriter {
	readonly pid: number;
	readonly startTime: string | null;
}

export interface RegisteredHost {
	readonly record: DaemonPidFile;
	readonly writer?: HostPidFileWriter;
	/** The endpoint this record is about. Absent in records written before the field existed. */
	readonly socket?: string;
}

export async function readPidFile(paths: HostDaemonPaths): Promise<RegisteredHost | undefined> {
	let text: string;
	try {
		text = await readFile(paths.pidFile, "utf8");
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	const record = parseDaemonPidFile(text);
	if (record === undefined) return undefined;
	const parsed = parseJson(text);
	return {
		record,
		...(parseWriter(parsed) && { writer: parseWriter(parsed) }),
		...(typeof parsed?.socket === "string" && { socket: parsed.socket }),
	};
}

/**
 * Registers a host under this process's writer stamp. The stamp is what authorizes a later
 * stop: only the process that wrote a record may signal the host it names, and the recorded
 * start time keeps a recycled pid from inheriting that right.
 */
export async function writePidFile(
	paths: HostDaemonPaths,
	registration: { readonly record: DaemonPidFile; readonly socket: string },
): Promise<void> {
	const writer: HostPidFileWriter = { pid: process.pid, startTime: await thisProcessStartTime() };
	await mkdir(paths.dir, { recursive: true });
	await writeFile(
		paths.pidFile,
		`${JSON.stringify({ ...registration.record, socket: registration.socket, writer })}\n`,
		{
			mode: 0o600,
		},
	);
}

/**
 * I1 in one predicate: the pidfile names a host THIS process started. A writer that cannot be
 * proven ours reads as foreign, so the worst case of an unreadable identity is a refusal rather
 * than a signal sent to another owner's host.
 */
export async function writtenByThisProcess(writer: HostPidFileWriter | undefined): Promise<boolean> {
	if (writer === undefined || writer.pid !== process.pid || writer.startTime === null) return false;
	return writer.startTime === (await thisProcessStartTime());
}

let selfStartTime: Promise<string | null> | undefined;

export function thisProcessStartTime(): Promise<string | null> {
	selfStartTime ??= readProcessStartTime(process.pid).then(
		(value) => value ?? null,
		() => null,
	);
	return selfStartTime;
}

/** Settings a supervisor reads at boot. Written before the spawn, so it exists when the host starts. */
export interface HostDaemonSettings {
	readonly socket: string;
	readonly capabilities: readonly string[];
	readonly coldStart: string;
	readonly idleExitMs: number;
	/** Which generation of this daemon the spawn is; `0` for a host nobody has handed off yet. */
	readonly generation: number;
}

export async function writeHostSettings(paths: HostDaemonPaths, settings: HostDaemonSettings): Promise<void> {
	await mkdir(paths.dir, { recursive: true });
	await writeFile(paths.settingsFile, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
}

/** The policy the running generation was started with, for a successor that states none of its own. */
export async function readHostSettings(
	paths: HostDaemonPaths,
): Promise<{ coldStart?: HostDaemonSettings["coldStart"]; idleExitMs?: number } | undefined> {
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = parseJson(await readFile(paths.settingsFile, "utf8"));
	} catch {
		return undefined;
	}
	if (!parsed) return undefined;
	return {
		...(typeof parsed.coldStart === "string" && { coldStart: parsed.coldStart }),
		...(typeof parsed.idleExitMs === "number" && { idleExitMs: parsed.idleExitMs }),
	};
}

/** A record from a host started before writer stamps existed simply has no writer: it reads as foreign. */
function parseWriter(parsed: Record<string, unknown> | undefined): HostPidFileWriter | undefined {
	if (!parsed || !isRecord(parsed.writer) || typeof parsed.writer.pid !== "number") return undefined;
	const { pid, startTime } = parsed.writer;
	return { pid, startTime: typeof startTime === "string" ? startTime : null };
}

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
