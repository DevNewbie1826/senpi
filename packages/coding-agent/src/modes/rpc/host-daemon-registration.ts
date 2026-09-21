/**
 * What a running daemon's records SAY, and who is allowed to act on what they say.
 *
 * Two files describe a running daemon, and that split is the point:
 *
 * - the POINTER (`<daemonDir>/host.pid`) names the generation that currently owns the socket, and
 *   carries no `pid` or `processStartTime` key, so a client from before layout 2 can neither parse
 *   it nor derive a pid to signal from it;
 * - `generations/<instanceId>/host.pid` is the RECORD of one generation: which process serves the
 *   socket, which identity guards that pid, which build it runs, and who registered it.
 *
 * Three fields carry the evidence invariant I1 rests on (never terminate, signal or replace a host
 * you did not start), and each exists because a specific mistake is otherwise unprovable:
 *
 * - `processStartTime` - a pid alone is recycled by the OS, so a stale record would authorize a
 *   signal to an unrelated process.
 * - `writer` - the identity of the process that WROTE the record. Only that process may stop the
 *   host it names; anyone else attaches or refuses.
 * - `instance_id` - which generation the pointer is about, so a predecessor draining after a handoff
 *   removes its own directory and leaves the successor's registration alone.
 *
 * Where those files LIVE, and the modes they are written with, belong to `host-daemon-state.ts`;
 * this module reads and writes through its primitives and never builds a path of its own.
 */
import { rename, rm } from "node:fs/promises";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	parseDaemonPidFile,
	processMatchesPidFile,
	readProcessStartTime,
} from "../app-server/daemon/process.ts";
import {
	createGenerationDirectory,
	generationPaths,
	HOST_DAEMON_LAYOUT,
	type HostDaemonPaths,
} from "./host-daemon-paths.ts";
import { isRecord, parseJson, readFileOrUndefined, writeStateFile } from "./host-daemon-state.ts";
import { pruneDeadGenerations } from "./host-generations.ts";

/** Who wrote a registration: the process identity a later stop must match to be allowed. */
export interface HostPidFileWriter {
	readonly pid: number;
	readonly startTime: string | null;
}

/** What an ensure knows about the generation it just spawned. */
export interface HostRegistration {
	readonly record: DaemonPidFile;
	readonly socket: string;
	readonly instanceId: string;
	readonly generation: number;
	/** The profile the spawned host was launched with, for a client comparing two generations. */
	readonly launchProfileId: string;
}

export interface RegisteredHost {
	readonly record: DaemonPidFile;
	readonly writer?: HostPidFileWriter;
	/** The endpoint this record is about. Absent in records written before the field existed. */
	readonly socket?: string;
	readonly instanceId: string;
	readonly generation: number;
}

/**
 * The generation the pointer names, or nothing. A pointer without a readable generation record
 * describes no process, so it authorizes nothing - the next ensure overwrites it.
 */
export async function readHostRegistration(paths: HostDaemonPaths): Promise<RegisteredHost | undefined> {
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile));
	if (!pointer || typeof pointer.instance_id !== "string") return undefined;
	const text = await readFileOrUndefined(generationPaths(paths, pointer.instance_id).pidFile);
	const record = text === undefined ? undefined : parseDaemonPidFile(text);
	if (record === undefined) return undefined;
	const parsed = parseJson(text) ?? {};
	const writer = parseWriter(parsed);
	return {
		record,
		...(writer && { writer }),
		...(typeof parsed.socket === "string" && { socket: parsed.socket }),
		instanceId: pointer.instance_id,
		generation: typeof parsed.generation === "number" ? parsed.generation : 0,
	};
}

/**
 * Registers a generation and points the daemon directory at it, under this process's writer stamp.
 * The stamp is what authorizes a later stop: only the process that wrote a record may signal the
 * host it names, and the recorded start time keeps a recycled pid from inheriting that right.
 */
export async function writeHostRegistration(paths: HostDaemonPaths, registration: HostRegistration): Promise<void> {
	// Every write is also the moment to drop what is no longer running: records of dead generations
	// and their session-path claims otherwise accumulate for the life of the agent directory, and a
	// stale pointer among them reads as "a daemon serves this endpoint" (#1893).
	await pruneDeadGenerations(paths);
	const generation = generationPaths(paths, registration.instanceId);
	const writer: HostPidFileWriter = { pid: process.pid, startTime: await thisProcessStartTime() };
	const build = engineBuildIdentity();
	await createGenerationDirectory(generation);
	await writeStateFile(generation.pidFile, {
		...registration.record,
		instance_id: registration.instanceId,
		generation: registration.generation,
		engineVersion: build.text,
		engineOrdinal: build.ordinal,
		launchProfileId: registration.launchProfileId,
		socket: registration.socket,
		writer,
	});
	// The pointer is replaced by rename: a reader either sees the generation that owned the socket
	// before this call or the one that owns it now, never a half-written pointer.
	await writeStateFile(`${paths.pointerFile}.${process.pid}.tmp`, {
		layout: HOST_DAEMON_LAYOUT,
		instance_id: registration.instanceId,
		generation_dir: generation.relativeDir,
		writer,
	});
	await rename(`${paths.pointerFile}.${process.pid}.tmp`, paths.pointerFile);
}

/** Drops the pointer, the generation it names and the boot settings: the host behind them is gone. */
export async function clearHostRegistration(paths: HostDaemonPaths): Promise<void> {
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile));
	if (typeof pointer?.instance_id === "string") {
		await rm(generationPaths(paths, pointer.instance_id).dir, { recursive: true, force: true });
	}
	await rm(paths.pointerFile, { force: true });
	await rm(paths.settingsFile, { force: true });
}

/**
 * Drops ONE generation's registration while the files still name it. After a handoff the pointer
 * belongs to the successor, so a draining predecessor removes only its own directory - taking the
 * pointer with it would leave every client reading no daemon at all while one is serving.
 */
export async function releaseGeneration(
	paths: HostDaemonPaths,
	owner: { readonly instanceId: string; readonly pid: number },
): Promise<void> {
	const generation = generationPaths(paths, owner.instanceId);
	const record = parseDaemonPidFile((await readFileOrUndefined(generation.pidFile)) ?? "");
	if (record !== undefined && record.pid !== owner.pid) return;
	const pointer = parseJson(await readFileOrUndefined(paths.pointerFile));
	if (pointer?.instance_id === owner.instanceId) {
		await rm(paths.pointerFile, { force: true });
		await rm(paths.settingsFile, { force: true });
	}
	await rm(generation.dir, { recursive: true, force: true });
}

/**
 * A LEGACY host's flat registration, if one is there. This build never writes and never removes it:
 * it is evidence that a host from before layout 2 may still own the socket, and nothing more.
 */
export async function readLegacyHostRecord(paths: HostDaemonPaths): Promise<DaemonPidFile | undefined> {
	const text = await readFileOrUndefined(paths.legacyPidFile);
	return text === undefined ? undefined : parseDaemonPidFile(text);
}

/**
 * The generation serving this socket, when - and only when - its record PROVES which process that
 * is. An owner nobody can prove may not be signalled at all (I1), so an unreadable identity, a
 * missing guard or a record about another endpoint all read as "no owner".
 */
export async function provenOwner(
	registered: RegisteredHost | undefined,
	socket: string,
): Promise<{ pid: number; processStartTime: string; instanceId: string } | undefined> {
	const record = registered?.record;
	if (!record || record.processStartTime === null) return undefined;
	if (registered?.socket !== undefined && registered.socket !== socket) return undefined;
	const identity = { pid: record.pid, processStartTime: record.processStartTime };
	return (await processMatchesPidFile(identity, readProcessStartTime).catch(() => false))
		? { ...identity, instanceId: registered.instanceId }
		: undefined;
}

/**
 * Whether a LEGACY host is still running behind the flat registration. An identity that cannot be
 * read on a live pid counts as running: the point of asking is to refuse rather than start a second
 * host beside a process that may still own the socket.
 */
export async function legacyHostIsLive(
	paths: HostDaemonPaths,
	probe: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
	const record = await readLegacyHostRecord(paths);
	if (record === undefined) return false;
	try {
		return await processMatchesPidFile(record, probe);
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return true;
		throw error;
	}
}

/**
 * I1 in one predicate: the registration names a host THIS process started. A writer that cannot be
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

/** A record from a host started before writer stamps existed simply has no writer: it reads as foreign. */
function parseWriter(parsed: Record<string, unknown>): HostPidFileWriter | undefined {
	if (!isRecord(parsed.writer) || typeof parsed.writer.pid !== "number") return undefined;
	const { pid, startTime } = parsed.writer;
	return { pid, startTime: typeof startTime === "string" ? startTime : null };
}
