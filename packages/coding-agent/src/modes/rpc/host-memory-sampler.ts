import type { RpcHostMemoryPressureEvent } from "./rpc-types.ts";

/** Environment override for the RSS warning threshold, in megabytes. */
export const HOST_RSS_WARN_MB_ENV = "SENPI_RPC_HOST_RSS_WARN_MB";
export const DEFAULT_HOST_RSS_WARN_MB = 4096;
/** Sampling interval. Memory moves slowly; this is bookkeeping, not a hot loop. */
export const HOST_MEMORY_SAMPLE_MS = 30_000;
/** One stderr line per window, however many samples stay above the threshold. */
export const HOST_MEMORY_STDERR_INTERVAL_MS = 5 * 60_000;

const BYTES_PER_MEGABYTE = 1024 * 1024;

export interface HostMemorySamplerOptions {
	/** Delivers one `host_memory_pressure` lifecycle record to every connection. */
	readonly emit: (record: RpcHostMemoryPressureEvent) => void;
	/** Live session count published with the record. */
	readonly sessions: () => number;
	/** Raised while the host is above the threshold; the router halves idle parking. */
	readonly onPressure: (pressure: boolean) => void;
	/** Defaults to one stderr line; tests capture it. */
	readonly log?: (message: string) => void;
	readonly now?: () => number;
	readonly readRssBytes?: () => number;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resident-memory reporter for the shared host.
 *
 * The daemon's capacity is memory, never a refusal: it never declines a session, never
 * kills one, and never counts them against a cap. What it does is SAY how much memory
 * it holds - as a lifecycle record to every connection and one stderr line per five
 * minutes - and, while it is above the threshold, tell the router to park idle sessions
 * at half the usual window so their memory returns to the process sooner.
 */
export class HostMemorySampler {
	private readonly emit: (record: RpcHostMemoryPressureEvent) => void;
	private readonly sessions: () => number;
	private readonly onPressure: (pressure: boolean) => void;
	private readonly log: (message: string) => void;
	private readonly now: () => number;
	private readonly readRssBytes: () => number;
	private readonly warnMb: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private pressure = false;
	private lastLoggedAt: number | undefined;

	constructor(options: HostMemorySamplerOptions) {
		const env = options.env ?? process.env;
		this.emit = options.emit;
		this.sessions = options.sessions;
		this.onPressure = options.onPressure;
		this.log = options.log ?? ((message) => void process.stderr.write(message));
		this.now = options.now ?? Date.now;
		this.readRssBytes = options.readRssBytes ?? (() => process.memoryUsage.rss());
		this.warnMb = parsePositiveInteger(env[HOST_RSS_WARN_MB_ENV]) ?? DEFAULT_HOST_RSS_WARN_MB;
	}

	start(): void {
		if (this.timer !== undefined) return;
		// Unref'd: memory bookkeeping must never be the reason the host stays alive.
		this.timer = setInterval(() => this.sample(), HOST_MEMORY_SAMPLE_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One sample. Public so tests drive it on an injected clock and RSS reading. */
	sample(): void {
		const rssMb = Math.round(this.readRssBytes() / BYTES_PER_MEGABYTE);
		if (rssMb <= this.warnMb) {
			if (!this.pressure) return;
			this.pressure = false;
			this.onPressure(false);
			return;
		}
		if (!this.pressure) {
			this.pressure = true;
			this.onPressure(true);
		}
		const sessions = this.sessions();
		this.emit({ type: "host_memory_pressure", rssMb, sessions });
		const now = this.now();
		if (this.lastLoggedAt !== undefined && now - this.lastLoggedAt < HOST_MEMORY_STDERR_INTERVAL_MS) return;
		this.lastLoggedAt = now;
		this.log(`senpi rpc host memory pressure: rssMb=${rssMb} sessions=${sessions} (idle parking halved)\n`);
	}
}
