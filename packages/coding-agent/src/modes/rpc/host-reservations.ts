/**
 * Which session file each generation of the daemon currently holds open.
 *
 * Inside one host process the registry's own reservation set is the authority. Across
 * GENERATIONS it cannot be: during a handoff two hosts are alive at the same time, and the
 * successor must not open a session file the predecessor is still writing - two writers on
 * one JSONL interleave partial records and the transcript is silently corrupted.
 *
 * So every open publishes a small claim next to the daemon state, and every close removes it.
 * A claim is evidence, not a lock: it names the process that made it, so a claim whose owner is
 * gone (a SIGKILLed host, a reboot, a recycled pid with a different start time) is ignored
 * rather than trusted. The failure mode is therefore "a reopen waits ~2s for a live writer to
 * finish", never "a session file can never be opened again".
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processIsLive, readProcessStartTime } from "../app-server/daemon/process.ts";
import { createHostDaemonPaths, HOST_DAEMON_DIR_ENV } from "./host-daemon-paths.ts";

/** How long a client should wait before retrying a path another generation still holds. */
export const SESSION_PATH_RETRY_AFTER_MS = 2_000;

export interface SessionPathOwner {
	readonly instanceId: string;
	readonly pid: number;
	readonly processStartTime: string | null;
	readonly sessionPath: string;
}

export interface SessionPathReservations {
	/** Records this host as the holder of `sessionPath`, or reports the live foreign holder. */
	claim(sessionPath: string): Promise<SessionPathOwner | undefined>;
	/** Drops this host's claim. A claim made by another generation is never touched. */
	release(sessionPath: string): void;
}

/** One claim per canonical session path, named by its hash so the file name is bounded. */
export function reservationFile(dir: string, sessionPath: string): string {
	return join(dir, `${createHash("sha256").update(sessionPath, "utf8").digest("hex").slice(0, 16)}.json`);
}

/**
 * The claims of a host serving one ENDPOINT, or none when there is no endpoint to share. A
 * supervised host is TOLD its daemon directory, because the socket it binds is a private hop rather
 * than the public endpoint; a bare socket host derives it from what it listens on; a stdio host has
 * no daemon directory, no successor generation and therefore nothing to publish.
 */
export function createEndpointReservations(host: {
	readonly agentDir: string;
	readonly socket: string | undefined;
	readonly instanceId: string;
	readonly onFailure?: (message: string) => void;
}): SessionPathReservations | undefined {
	const told = process.env[HOST_DAEMON_DIR_ENV];
	const dir =
		told !== undefined && told.trim() !== ""
			? told
			: host.socket === undefined
				? undefined
				: createHostDaemonPaths({ socket: host.socket, agentDir: host.agentDir }).dir;
	if (dir === undefined) return undefined;
	return createSessionPathReservations({
		dir: join(dir, "reservations"),
		instanceId: host.instanceId,
		...(host.onFailure ? { onFailure: host.onFailure } : {}),
	});
}

export function createSessionPathReservations(options: {
	readonly dir: string;
	readonly instanceId: string;
	readonly pid?: number;
	readonly onFailure?: (message: string) => void;
}): SessionPathReservations {
	const pid = options.pid ?? process.pid;
	const startTime = readProcessStartTime(pid).then(
		(value) => value ?? null,
		() => null,
	);
	const held = new Set<string>();
	const report = (message: string): void => options.onFailure?.(message);
	return {
		async claim(sessionPath: string): Promise<SessionPathOwner | undefined> {
			const file = reservationFile(options.dir, sessionPath);
			const existing = await readOwner(file);
			if (existing && existing.pid !== pid && (await ownerIsLive(existing))) return existing;
			const owner: SessionPathOwner = {
				instanceId: options.instanceId,
				pid,
				processStartTime: await startTime,
				sessionPath,
			};
			try {
				await mkdir(options.dir, { recursive: true, mode: 0o700 });
				// Written aside and renamed in: a reader never sees half a claim.
				const staging = `${file}.${pid}.tmp`;
				await writeFile(staging, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
				await rename(staging, file);
				held.add(sessionPath);
			} catch (cause) {
				// A daemon directory that cannot be written is not a reason to refuse a session: the
				// in-process reservation still protects this host, and a handoff is the only thing
				// that loses its guard. Say so once rather than failing the open.
				report(`session path reservation for ${sessionPath} could not be written (${errorMessage(cause)})`);
			}
			return undefined;
		},
		release(sessionPath: string): void {
			if (!held.delete(sessionPath)) return;
			void rm(reservationFile(options.dir, sessionPath), { force: true }).catch((cause: unknown) => {
				report(`session path reservation for ${sessionPath} could not be removed (${errorMessage(cause)})`);
			});
		},
	};
}

async function readOwner(file: string): Promise<SessionPathOwner | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch {
		// Absent, unreadable or half-written: no claim that anyone could act on.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { instanceId, pid, processStartTime, sessionPath } = parsed as Record<string, unknown>;
	if (typeof instanceId !== "string" || typeof pid !== "number" || typeof sessionPath !== "string") return undefined;
	return {
		instanceId,
		pid,
		processStartTime: typeof processStartTime === "string" ? processStartTime : null,
		sessionPath,
	};
}

/**
 * A claim counts only while the process that made it is still running. The recorded start time is
 * what separates "that host is still writing" from "the OS handed its pid to something else".
 */
async function ownerIsLive(owner: SessionPathOwner): Promise<boolean> {
	if (!processIsLive(owner.pid)) return false;
	if (owner.processStartTime === null) return true;
	const current = await readProcessStartTime(owner.pid).catch(() => undefined);
	return current === undefined || current === owner.processStartTime;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
