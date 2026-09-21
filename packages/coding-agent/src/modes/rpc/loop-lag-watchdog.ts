import { parseIdleExitMs } from "./host-lifecycle.ts";
import { recordLoopBlockedMs } from "./loop-blocked-time.ts";
import type { RpcHostStalledEvent } from "./rpc-types.ts";
import { type SessionAttribution, sessionActivityMark, sessionActivitySince } from "./session-attribution.ts";

/** Environment override for the drift that logs a warning, in milliseconds. */
export const LOOP_LAG_WARN_MS_ENV = "SENPI_RPC_LOOP_LAG_WARN_MS";
/** Environment override for the drift that also emits `host_stalled`, in milliseconds. */
export const LOOP_LAG_ERROR_MS_ENV = "SENPI_RPC_LOOP_LAG_ERROR_MS";
export const DEFAULT_LOOP_LAG_WARN_MS = 500;
export const DEFAULT_LOOP_LAG_ERROR_MS = 5_000;
/** Measurement interval: short enough to bound the blamed window, cheap enough to ignore. */
export const LOOP_LAG_TICK_MS = 200;
/** One warning per window, however many stalls it covers. */
export const LOOP_LAG_WARN_INTERVAL_MS = 10_000;

export interface LoopLagWatchdogOptions {
	/** Delivers one `host_stalled` lifecycle record to every connection. */
	readonly emit: (record: RpcHostStalledEvent) => void;
	/** Defaults to one stderr line; tests capture it. */
	readonly log?: (message: string) => void;
	readonly now?: () => number;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

function describeAttribution(attribution: SessionAttribution | undefined): string {
	if (attribution?.sessionId === undefined && attribution?.tool === undefined) return "no attributed session";
	return `sessionId=${attribution.sessionId ?? "unknown"}${attribution.tool ? ` tool=${attribution.tool}` : ""}`;
}

/**
 * Event-loop stall detector for the shared host.
 *
 * Every in-process session runs on the host's one event loop, so a session that blocks
 * it freezes every other session and the transport with it. A 200 ms timer measures how
 * late it is actually invoked: that lateness IS the time the loop spent unable to serve
 * anyone. Past the warning threshold the host says so once per 10 s, naming the session
 * and tool whose work held the loop; past the error threshold it also emits a
 * `host_stalled` lifecycle record so attached clients (and the desktop) can show it.
 *
 * The watchdog only reports. It never aborts a turn, kills a session, or refuses work.
 */
export class LoopLagWatchdog {
	private readonly emit: (record: RpcHostStalledEvent) => void;
	private readonly log: (message: string) => void;
	private readonly now: () => number;
	private readonly warnMs: number;
	private readonly errorMs: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private expectedTickAt: number | undefined;
	private activityMark = 0;
	private lastWarnAt: number | undefined;

	constructor(options: LoopLagWatchdogOptions) {
		const env = options.env ?? process.env;
		this.emit = options.emit;
		this.log = options.log ?? ((message) => void process.stderr.write(message));
		this.now = options.now ?? Date.now;
		this.warnMs = parseIdleExitMs(env[LOOP_LAG_WARN_MS_ENV]) ?? DEFAULT_LOOP_LAG_WARN_MS;
		this.errorMs = parseIdleExitMs(env[LOOP_LAG_ERROR_MS_ENV]) ?? DEFAULT_LOOP_LAG_ERROR_MS;
	}

	start(): void {
		if (this.timer !== undefined) return;
		this.expectedTickAt = this.now() + LOOP_LAG_TICK_MS;
		this.activityMark = sessionActivityMark();
		// Unref'd: watching the loop must never be the reason the host stays alive.
		this.timer = setInterval(() => this.tick(), LOOP_LAG_TICK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
		this.expectedTickAt = undefined;
	}

	/**
	 * One measurement. Public so tests drive it on an injected clock instead of
	 * waiting for real drift. The first tick only establishes the baseline.
	 */
	tick(): void {
		const now = this.now();
		const expectedAt = this.expectedTickAt ?? now;
		const previousMark = this.activityMark;
		this.expectedTickAt = now + LOOP_LAG_TICK_MS;
		this.activityMark = sessionActivityMark();
		const driftMs = Math.round(now - expectedAt);
		recordLoopBlockedMs(driftMs);
		if (driftMs <= this.warnMs) return;
		const attribution = sessionActivitySince(previousMark);
		if (driftMs > this.errorMs)
			this.emit({ type: "host_stalled", driftMs, sessionId: attribution?.sessionId, tool: attribution?.tool });
		if (this.lastWarnAt !== undefined && now - this.lastWarnAt < LOOP_LAG_WARN_INTERVAL_MS) return;
		this.lastWarnAt = now;
		this.log(`senpi rpc host stall: event loop blocked ${driftMs}ms (${describeAttribution(attribution)})\n`);
	}
}
