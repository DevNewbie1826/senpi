/**
 * The daemon's on-disk state for ONE socket: where the files live, what they say, and who may act
 * on what they say.
 *
 * Layout 2 gives every endpoint its own directory, named by the socket it serves:
 *
 *     <agentDir>/rpc-host-daemon/                 the flat directory - shared, and left legacy-empty
 *       layout.json                               { layout: 2, dir } - the only file this build writes here
 *       <sha256(socket)[:16]>/                    0700, one per endpoint
 *         host.pid                                POINTER: { layout, instance_id, generation_dir, writer }
 *         settings.json                           what the supervisor reads at boot
 *         daemon.lock  stderr.log
 *         generations/<instanceId>/               one per generation of this daemon
 *           host.pid  settings.json  scratch/
 *         reservations/                           cross-generation session-path claims
 *
 * The flat directory is deliberately missing the one file every DEPLOYED client looks for. A flat
 * `host.pid` holding `{ pid, processStartTime }` is exactly what arms their kill paths - the desktop's
 * `readManagedHost` -> takeover, and a pre-layout-2 `ensureHost` -> `stopManagedHost` - so writing one
 * would make an un-updated client replace this daemon and end every other client's sessions. Without
 * it both fail CLOSED: they see no host of their own, refuse, and leave the daemon alone. Nothing here
 * ever writes a legacy-shaped file, and nothing here ever removes one: a flat `host.pid` that DOES
 * exist belongs to a legacy host that may still be running, and is read-only to this build.
 *
 * Two files describe a RUNNING daemon, and that split is the point:
 *
 * - the POINTER names the generation that currently owns the socket, and carries no `pid` or
 *   `processStartTime` key, so a client from before layout 2 can neither parse it nor derive a pid
 *   to signal from it;
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
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, win32 } from "node:path";
import { getAgentDir } from "../../config.ts";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	parseDaemonPidFile,
	processMatchesPidFile,
	readProcessStartTime,
} from "../app-server/daemon/process.ts";

/** The layout this build writes. A directory without the marker predates it and is never touched. */
export const HOST_DAEMON_LAYOUT = 2;

/** Absolute daemon directory handed to a spawned host, which binds a private socket of its own. */
export const HOST_DAEMON_DIR_ENV = "SENPI_RPC_HOST_DAEMON_DIR";

const DIRECTORY_MODE = 0o700;
export const HOST_STATE_FILE_MODE = 0o600;

export interface HostDaemonPaths {
	/** `<agentDir>/rpc-host-daemon`: shared by every endpoint, and by any legacy host's own state. */
	readonly flatDir: string;
	/** The only file this build writes into the flat directory: `{ layout, dir }`. */
	readonly layoutMarker: string;
	/** A LEGACY host's registration. Read-only evidence that another host may be running. */
	readonly legacyPidFile: string;
	/** This endpoint's state directory, `<flatDir>/<sha256(socket)[:16]>`. */
	readonly dir: string;
	/** The pointer at the current generation. Deliberately unparseable as a legacy pidfile. */
	readonly pointerFile: string;
	/** Cross-version ensure lock for this endpoint (the endpoint lock itself lives in the temp dir). */
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
	readonly generationsDir: string;
	readonly reservationsDir: string;
}

export interface HostGenerationPaths {
	readonly dir: string;
	/** Where the pointer names this generation: relative to the daemon directory holding it. */
	readonly relativeDir: string;
	readonly pidFile: string;
	readonly settingsFile: string;
	readonly scratchDir: string;
}

/**
 * The directory name every client recomputes from the socket alone: `sha256(<canonical endpoint>)`,
 * where the canonical endpoint is the socket path on POSIX and the normalized lower-cased path on
 * win32 (the same canonicalization the pipe name is derived from, so two spellings of one endpoint
 * share one directory). Deliberately total: naming a directory must never fail on a path shape the
 * transport would reject, or a client could not even report WHERE it was looking.
 */
export function daemonDirectoryName(socket: string, platform: NodeJS.Platform = process.platform): string {
	const canonical = platform === "win32" ? win32.normalize(socket).toLowerCase() : socket;
	return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/**
 * The daemon directory of ONE endpoint. Both fields are named rather than positional on purpose:
 * two strings in a row is exactly the call a refactor silently swaps, and swapping these two would
 * point a client at another socket's state.
 */
export function createHostDaemonPaths(target: {
	readonly socket: string;
	readonly agentDir?: string;
}): HostDaemonPaths {
	const flatDir = join(target.agentDir ?? getAgentDir(), "rpc-host-daemon");
	const dir = join(flatDir, daemonDirectoryName(target.socket));
	return {
		flatDir,
		layoutMarker: join(flatDir, "layout.json"),
		legacyPidFile: join(flatDir, "host.pid"),
		dir,
		pointerFile: join(dir, "host.pid"),
		lockFile: join(dir, "daemon.lock"),
		settingsFile: join(dir, "settings.json"),
		stderrLog: join(dir, "stderr.log"),
		generationsDir: join(dir, "generations"),
		reservationsDir: join(dir, "reservations"),
	};
}

export function generationPaths(paths: HostDaemonPaths, instanceId: string): HostGenerationPaths {
	const dir = join(paths.generationsDir, instanceId);
	return {
		dir,
		relativeDir: `generations/${instanceId}`,
		pidFile: join(dir, "host.pid"),
		settingsFile: join(dir, "settings.json"),
		scratchDir: join(dir, "scratch"),
	};
}

/** A daemon directory that cannot be created or written, named so the caller can say WHICH path failed. */
export class HostDaemonStateError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(`RPC daemon state directory ${path} is not usable: ${cause instanceof Error ? cause.message : cause}`, {
			cause,
		});
		this.name = "HostDaemonStateError";
		this.path = path;
	}
}

/**
 * Creates this endpoint's directories and publishes the flat marker. The modes are set explicitly
 * rather than left to `mkdir`, because a directory that already exists keeps whatever mode it was
 * created with - and this one holds the evidence that decides who may signal the daemon.
 */
export async function createDaemonDirectories(paths: HostDaemonPaths): Promise<void> {
	try {
		// The flat directory may predate this layout and may hold a legacy host's files: it is created
		// when missing and never re-moded, so a legacy host keeps whatever it set up for itself.
		await mkdir(paths.flatDir, { recursive: true, mode: DIRECTORY_MODE });
		for (const directory of [paths.dir, paths.generationsDir, paths.reservationsDir]) {
			await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
			await chmod(directory, DIRECTORY_MODE);
		}
		await writeFile(
			paths.layoutMarker,
			`${JSON.stringify({ layout: HOST_DAEMON_LAYOUT, dir: basename(paths.dir) })}\n`,
			{ mode: HOST_STATE_FILE_MODE },
		);
	} catch (cause) {
		throw new HostDaemonStateError(paths.dir, cause);
	}
}

/** Creates one generation's private directory. Same failure shape as the daemon directory itself. */
export async function createGenerationDirectory(generation: HostGenerationPaths): Promise<void> {
	try {
		await mkdir(generation.scratchDir, { recursive: true, mode: DIRECTORY_MODE });
		await chmod(generation.dir, DIRECTORY_MODE);
	} catch (cause) {
		throw new HostDaemonStateError(generation.dir, cause);
	}
}

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

/** Settings a supervisor reads at boot. Written before the spawn, so it exists when the host starts. */
export interface HostDaemonSettings {
	readonly socket: string;
	readonly capabilities: readonly string[];
	readonly coldStart: string;
	readonly idleExitMs: number;
	/** Which generation of this daemon the spawn is; `0` for a host nobody has handed off yet. */
	readonly generation: number;
	/** Which generation directory the spawn will register itself in. */
	readonly instanceId: string;
}

/**
 * Publishes the settings a generation is started with, in both places they are read: the daemon
 * directory (what the supervisor loads at boot) and the generation's own directory (what that
 * generation was started with, which survives the next generation overwriting the boot copy).
 */
export async function writeHostSettings(paths: HostDaemonPaths, settings: HostDaemonSettings): Promise<void> {
	const generation = generationPaths(paths, settings.instanceId);
	await createGenerationDirectory(generation);
	await writeStateFile(paths.settingsFile, settings);
	await writeStateFile(generation.settingsFile, settings);
}

/** The policy the running generation was started with, for a successor that states none of its own. */
export async function readHostSettings(
	paths: HostDaemonPaths,
): Promise<{ coldStart?: HostDaemonSettings["coldStart"]; idleExitMs?: number } | undefined> {
	const parsed = parseJson(await readFileOrUndefined(paths.settingsFile));
	if (!parsed) return undefined;
	return {
		...(typeof parsed.coldStart === "string" && { coldStart: parsed.coldStart }),
		...(typeof parsed.idleExitMs === "number" && { idleExitMs: parsed.idleExitMs }),
	};
}

async function writeStateFile(path: string, content: unknown): Promise<void> {
	try {
		await writeFile(path, `${JSON.stringify(content)}\n`, { mode: HOST_STATE_FILE_MODE });
	} catch (cause) {
		throw new HostDaemonStateError(path, cause);
	}
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return undefined;
		throw error;
	}
}

/** A record from a host started before writer stamps existed simply has no writer: it reads as foreign. */
function parseWriter(parsed: Record<string, unknown>): HostPidFileWriter | undefined {
	if (!isRecord(parsed.writer) || typeof parsed.writer.pid !== "number") return undefined;
	const { pid, startTime } = parsed.writer;
	return { pid, startTime: typeof startTime === "string" ? startTime : null };
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return undefined;
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
