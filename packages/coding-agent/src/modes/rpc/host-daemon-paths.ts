/**
 * WHERE one socket's daemon keeps its state: the per-socket directory, the files inside it, and the
 * modes they are created with.
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
 * What those files CONTAIN is `host-daemon-state.ts` (settings, and the primitives every state file
 * is written through) and `host-daemon-registration.ts` (the pointer and the generation records).
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join, win32 } from "node:path";
import { getAgentDir } from "../../config.ts";

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
	return {
		flatDir,
		layoutMarker: join(flatDir, "layout.json"),
		legacyPidFile: join(flatDir, "host.pid"),
		...hostDaemonDirectoryPaths(join(flatDir, daemonDirectoryName(target.socket))),
	};
}

/**
 * The files inside one endpoint's directory, for a caller that was TOLD the directory instead of
 * the socket it serves - a supervised host binds a private hop, so it cannot derive the endpoint.
 * The names live here alone, so the directory a client recomputes and the one a host is handed
 * can never drift apart.
 */
export function hostDaemonDirectoryPaths(
	dir: string,
): Omit<HostDaemonPaths, "flatDir" | "layoutMarker" | "legacyPidFile"> {
	return {
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
