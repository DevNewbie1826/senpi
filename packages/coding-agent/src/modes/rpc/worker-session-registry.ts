import { isAbsolute } from "node:path";
import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { CliRuntimeConfiguration } from "../../main.ts";
import {
	type LiveWorkerPaths,
	RESERVATION_DENIAL_CODES,
	SessionPathReservations,
} from "./session-path-reservations.ts";
import {
	frozenProfile,
	type OpenRpcSession,
	type RpcSessionEntry,
	type RpcSessionLaunchProfile,
	type RpcSessionOpenOptions,
	RpcSessionRegistryError,
	type RpcSessionRow,
	sessionIdentity,
} from "./session-registry.ts";
import { SessionWorkerClient } from "./session-worker-client.ts";
import { SESSION_WORKER_LIMITS, type SessionWriteGrant } from "./session-worker-protocol.ts";

/** Transport-side lifecycle owner. Caller paths are never inspected on this event loop. */
export class WorkerSessionRegistry {
	private readonly entries = new Map<string, RpcSessionEntry>();
	private readonly reservations = new SessionPathReservations();
	private serial = 0;
	readonly closeGraceMs: number;
	private readonly now: () => number;

	private readonly options: { configuration: CliRuntimeConfiguration; closeGraceMs: number; now: () => number };

	constructor(options: { configuration: CliRuntimeConfiguration; closeGraceMs: number; now: () => number }) {
		this.options = options;
		this.closeGraceMs = options.closeGraceMs;
		this.now = options.now;
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * Memory admission is the in-process registry's concern: a worker-runtime session runs in
	 * its own isolate and this registry already bounds occupancy with `too_many_sessions`.
	 */
	setWorkerAdmission(): void {}

	async openSession(profile: RpcSessionLaunchProfile, options?: RpcSessionOpenOptions): Promise<OpenRpcSession> {
		if (!isAbsolute(profile.cwd) || (profile.sessionPath !== undefined && !isAbsolute(profile.sessionPath)))
			throw new RpcSessionRegistryError("invalid_path");
		if (profile.sessionPath) {
			const key = this.knownReservationKey(profile.sessionPath);
			const owner = key ? this.reservations.owner(key) : undefined;
			if (key && owner) return this.attach(owner, key, options);
		}
		if (this.size >= SESSION_WORKER_LIMITS.workers) throw new Error("too_many_sessions");
		const handle = `rpc-${++this.serial}`;
		const storedProfile = frozenProfile(profile);
		const entry: RpcSessionEntry = {
			state: "opening",
			scope: new ProviderScope(),
			profile: storedProfile,
			...sessionIdentity(storedProfile),
			cwd: profile.cwd,
			attachments: 1,
			retainOnDisconnect: options?.retainOnDisconnect === true,
			lastCommandAt: this.now(),
			lifecycleMutex: Promise.resolve(),
		};
		const worker = new SessionWorkerClient({
			reserve: (path) => this.reserve(handle, path),
			reconcile: (livePaths) => this.reconcile(handle, livePaths),
			exit: () => {
				if (this.entries.get(handle) !== entry) return;
				entry.state = "closed";
				this.entries.delete(handle);
				this.reservations.releaseAll(handle);
				entry.closeResolve?.();
			},
			failure: (error) => {
				entry.state = "quarantined";
				process.stderr.write(`senpi rpc session ${handle} quarantined: ${error}\n`);
			},
		});
		entry.worker = worker;
		this.entries.set(handle, entry);
		try {
			const path = await worker.prepare(this.options.configuration, profile);
			const owner = this.reservations.owner(path);
			if (owner) {
				const attached = this.attach(owner, path, options);
				entry.state = "quarantined";
				worker.quarantine();
				return attached;
			}
			const grant = this.reserve(handle, path);
			if (grant !== "granted") throw new RpcSessionRegistryError(RESERVATION_DENIAL_CODES[grant]);
			entry.reservationKey = path;
			entry.requestedPathKey = profile.sessionPath ? path : undefined;
			entry.sessionPath = path;
			const snapshot = await worker.commit();
			if (entry.state !== "opening") throw new RpcSessionRegistryError("session_closing");
			entry.durableSessionId = snapshot.state.sessionId;
			entry.cwd = snapshot.state.cwd;
			entry.state = "open";
			return this.openResult(handle, entry);
		} catch (cause) {
			entry.state = "quarantined";
			worker.quarantine();
			throw cause;
		}
	}

	peek(handle: string): RpcSessionEntry | undefined {
		return this.entries.get(handle);
	}

	getForCommand(handle: string, command: string): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (
			entry.state === "quarantined" ||
			(entry.state === "closing" &&
				!["abort", "abort_bash", "extension_ui_response", "extension_ui_progress"].includes(command))
		)
			throw new RpcSessionRegistryError("session_closing");
		if (entry.state !== "open" && entry.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		entry.lastCommandAt = this.now();
		return entry;
	}

	beginClose(handle: string, onRole?: (finalizer: boolean) => void, options?: { detach?: boolean }): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (entry.state === "closing" || entry.state === "quarantined") {
			onRole?.(false);
			return entry;
		}
		if (entry.state !== "open" && entry.state !== "opening") throw new RpcSessionRegistryError("unknown_session");
		entry.attachments--;
		if (entry.attachments > 0) return entry;
		// A retained session answers a client's detach by staying open at zero
		// attachments; only an explicit close or eviction reaches the worker.
		if (options?.detach && entry.retainOnDisconnect) {
			entry.attachments = 0;
			return entry;
		}
		entry.state = "closing";
		entry.closeCompletion = new Promise((resolve) => {
			entry.closeResolve = resolve;
		});
		onRole?.(true);
		return entry;
	}

	close(handle: string): Promise<void> {
		const entry = this.beginClose(handle);
		return entry.state === "closing" ? this.closeMarked(handle) : Promise.resolve();
	}

	async closeMarked(handle: string): Promise<void> {
		const entry = this.entries.get(handle);
		if (entry?.state !== "closing" || !entry.worker) throw new RpcSessionRegistryError("unknown_session");
		if (entry.closeStarted) return entry.closeCompletion;
		entry.closeStarted = true;
		// Reply on a bounded deadline, but keep entry, attachments and reservations until exit.
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			entry.worker.close(this.closeGraceMs),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					if (entry.state !== "closed") entry.state = "quarantined";
					resolve();
				}, this.closeGraceMs);
			}),
		]);
		if (timer) clearTimeout(timer);
	}

	list(): RpcSessionRow[] {
		return [...this.entries].map(([sessionId, entry]) => {
			const state = entry.worker?.snapshot?.state;
			return {
				sessionId,
				durableSessionId: state?.sessionId ?? entry.durableSessionId,
				sessionPath: state?.sessionFile ?? entry.sessionPath,
				cwd: state?.cwd ?? entry.cwd,
				name: state?.sessionName,
				kind: entry.kind,
				context: entry.context,
				// A closing entry has already released its last attachment; never publish that as negative.
				attachments: Math.max(0, entry.attachments),
				status: entry.state === "quarantined" ? "closing" : entry.state,
			};
		});
	}

	/** Only compare spellings already tied to a granted identity; do not inspect caller paths here. */
	private knownReservationKey(path: string): string | undefined {
		if (this.reservations.owner(path)) return path;
		for (const entry of this.entries.values()) {
			// An opening spelling maps only while the key granted for it is still held: a
			// superseded path belongs to nobody and must open its own worker.
			if (
				entry.profile.sessionPath === path &&
				entry.requestedPathKey &&
				this.reservations.owner(entry.requestedPathKey)
			)
				return entry.requestedPathKey;
			const snapshot = entry.worker?.snapshot;
			if (snapshot?.state.sessionFile === path) return snapshot.sessionPath;
		}
		return undefined;
	}

	private attach(owner: string, path: string, options?: RpcSessionOpenOptions): OpenRpcSession {
		const entry = this.entries.get(owner);
		if (entry?.state !== "open" || !entry.worker?.bindingReady || entry.worker.snapshot?.sessionPath !== path)
			throw new RpcSessionRegistryError("session_path_in_use");
		const result = this.openResult(owner, entry);
		entry.attachments++;
		// Retention is a property of the live session: any attach may ask for it, and
		// no attach may revoke it for the clients that already rely on it.
		if (options?.retainOnDisconnect) entry.retainOnDisconnect = true;
		entry.lastCommandAt = this.now();
		return { ...result, attached: true };
	}

	/** Granted paths currently held by a handle; the per-worker budget is bounded by it. */
	reservationCount(handle: string): number {
		return this.reservations.count(handle);
	}

	private reserve(handle: string, path: string): SessionWriteGrant {
		const entry = this.entries.get(handle);
		if (!entry) return "conflict";
		if (this.reservations.owner(path) === handle) return "granted";
		if (entry.state !== "opening" && entry.state !== "open") return "conflict";
		return this.reservations.reserve(handle, path, this.liveWorkerPaths(entry));
	}

	/**
	 * Releases the grants a worker's latest snapshot no longer claims.
	 *
	 * Only a fully open entry reports live writers. An entry still opening, closing or
	 * quarantined keeps every grant until its real exit, because a worker stuck in a
	 * syscall can still be writing a path it can no longer report.
	 */
	private reconcile(handle: string, livePaths: readonly string[]): void {
		const entry = this.entries.get(handle);
		if (entry?.state !== "open") return;
		const sessionPath = entry.worker?.snapshot?.sessionPath;
		this.reservations.reconcile(handle, { livePaths, sessionPath });
		if (!sessionPath) return;
		entry.reservationKey = sessionPath;
		entry.sessionPath = sessionPath;
	}

	/** The live view a full budget is reconciled against; absent while the entry cannot report one. */
	private liveWorkerPaths(entry: RpcSessionEntry): LiveWorkerPaths | undefined {
		const snapshot = entry.state === "open" ? entry.worker?.snapshot : undefined;
		if (!snapshot) return undefined;
		return { livePaths: snapshot.liveSessionPaths, sessionPath: snapshot.sessionPath };
	}

	private openResult(handle: string, entry: RpcSessionEntry): OpenRpcSession {
		const state = entry.worker?.snapshot?.state;
		if (!state) throw new RpcSessionRegistryError("open_failed");
		return { sessionId: handle, durableSessionId: state.sessionId, sessionPath: state.sessionFile };
	}
}
