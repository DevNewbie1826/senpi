import { describe, expect, it } from "vitest";
import {
	DEFAULT_HOST_RSS_WARN_MB,
	HOST_MEMORY_STDERR_INTERVAL_MS,
	HostMemorySampler,
} from "../../src/modes/rpc/host-memory-sampler.ts";
import type { RpcHostMemoryPressureEvent } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { evictionRegistry, idleEntry } from "./rpc-host-observer-support.ts";

/**
 * Capacity is memory, never a refusal: the host reports its own RSS and parks idle
 * sessions sooner while it is under pressure, and never declines a session for it.
 */

const MEGABYTE = 1024 * 1024;
const IDLE_WINDOW_MS = 1_000;

interface SamplerHarness {
	readonly records: RpcHostMemoryPressureEvent[];
	readonly logs: string[];
	readonly pressure: boolean[];
	readonly sampler: HostMemorySampler;
	advance(ms: number): void;
	setRssMb(rssMb: number): void;
}

function createSampler(env: Record<string, string | undefined> = {}): SamplerHarness {
	let clock = 0;
	let rssBytes = 0;
	const records: RpcHostMemoryPressureEvent[] = [];
	const logs: string[] = [];
	const pressure: boolean[] = [];
	const sampler = new HostMemorySampler({
		emit: (record) => records.push(record),
		sessions: () => 3,
		onPressure: (active) => pressure.push(active),
		log: (message) => logs.push(message),
		now: () => clock,
		readRssBytes: () => rssBytes,
		env,
	});
	return {
		records,
		logs,
		pressure,
		sampler,
		advance: (ms) => {
			clock += ms;
		},
		setRssMb: (rssMb) => {
			rssBytes = rssMb * MEGABYTE;
		},
	};
}

describe("host memory pressure", () => {
	it("stays silent below the RSS threshold", () => {
		// Given a host well below SENPI_RPC_HOST_RSS_WARN_MB
		const harness = createSampler();
		harness.setRssMb(DEFAULT_HOST_RSS_WARN_MB - 1);
		// When it samples
		harness.sampler.sample();
		// Then nothing is reported and no pressure hook fires
		expect(harness.records).toEqual([]);
		expect(harness.logs).toEqual([]);
		expect(harness.pressure).toEqual([]);
	});

	it("reports rss and session count on every sample above the threshold, logging once per 5 minutes", () => {
		// Given a host above the threshold
		const harness = createSampler();
		harness.setRssMb(DEFAULT_HOST_RSS_WARN_MB + 512);
		// When it samples three times inside one stderr window and once after it
		harness.sampler.sample();
		harness.advance(30_000);
		harness.sampler.sample();
		harness.advance(HOST_MEMORY_STDERR_INTERVAL_MS);
		harness.sampler.sample();
		// Then every sample emits a lifecycle record, while stderr carries one line per window
		expect(harness.records).toEqual([
			{ type: "host_memory_pressure", rssMb: DEFAULT_HOST_RSS_WARN_MB + 512, sessions: 3 },
			{ type: "host_memory_pressure", rssMb: DEFAULT_HOST_RSS_WARN_MB + 512, sessions: 3 },
			{ type: "host_memory_pressure", rssMb: DEFAULT_HOST_RSS_WARN_MB + 512, sessions: 3 },
		]);
		expect(harness.logs).toHaveLength(2);
		expect(harness.logs[0]).toContain(String(DEFAULT_HOST_RSS_WARN_MB + 512));
	});

	it("raises the pressure hook on entry and releases it on recovery, exactly once each", () => {
		// Given a host that crosses the threshold and later falls back under it
		const harness = createSampler();
		harness.setRssMb(DEFAULT_HOST_RSS_WARN_MB + 1);
		harness.sampler.sample();
		harness.sampler.sample();
		// When memory is released
		harness.setRssMb(DEFAULT_HOST_RSS_WARN_MB - 100);
		harness.sampler.sample();
		harness.sampler.sample();
		// Then the consumer saw one rise and one fall, not one per sample
		expect(harness.pressure).toEqual([true, false]);
	});

	it("takes its threshold from the environment", () => {
		// Given a host configured with a 256 MB warning threshold
		const harness = createSampler({ SENPI_RPC_HOST_RSS_WARN_MB: "256" });
		harness.setRssMb(300);
		// When it samples well below the default threshold
		harness.sampler.sample();
		// Then the override decides
		expect(harness.records).toEqual([{ type: "host_memory_pressure", rssMb: 300, sessions: 3 }]);
	});

	it("delivers host_memory_pressure to a connected client", async () => {
		// Given a writer with one connected client
		const writer = new SessionEventWriter(() => {});
		const lines: string[] = [];
		const delivered = new Promise<string>((resolve) => {
			writer.registerConnection("client-1", {
				writeRaw: (chunk) => {
					lines.push(chunk);
					resolve(chunk);
				},
				waitForBackpressure: async () => {},
			});
		});
		const sampler = new HostMemorySampler({
			emit: (record) => writer.broadcastHostRecord(record),
			sessions: () => 12,
			onPressure: () => {},
			log: () => {},
			readRssBytes: () => (DEFAULT_HOST_RSS_WARN_MB + 8) * MEGABYTE,
			env: {},
		});
		// When a sample lands above the threshold
		sampler.sample();
		// Then the client receives the lifecycle record
		await delivered;
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			type: "host_memory_pressure",
			rssMb: DEFAULT_HOST_RSS_WARN_MB + 8,
			sessions: 12,
		});
	});

	it("halves the idle-park window while the host is under memory pressure", async () => {
		// Given a router with a one-second idle window and a session idle for 600ms
		let clock = 0;
		const entry = idleEntry(0);
		const registry = evictionRegistry(entry);
		const router = new SessionCommandRouter(
			registry,
			new SessionEventWriter(() => {}),
			{ cwd: process.cwd() },
			undefined,
			{},
			{
				now: () => clock,
				idleEvictionMs: IDLE_WINDOW_MS,
			},
		);
		try {
			clock = 600;
			router.sweepIdleSessions();
			// Then nothing is parked yet
			expect(registry.closes).toEqual([]);
			// When the host reports memory pressure
			router.setMemoryPressure(true);
			router.sweepIdleSessions();
			// Then the same session is parked at half the window, and the host still counts it
			expect(registry.closes).toEqual(["rpc-1"]);
			expect(router.sessionCount).toBe(1);
		} finally {
			await router.dispose();
		}
	});

	it("restores the full idle-park window once pressure clears", async () => {
		// Given a router that was under memory pressure
		let clock = 0;
		const entry = idleEntry(0);
		const registry = evictionRegistry(entry);
		const router = new SessionCommandRouter(
			registry,
			new SessionEventWriter(() => {}),
			{ cwd: process.cwd() },
			undefined,
			{},
			{ now: () => clock, idleEvictionMs: IDLE_WINDOW_MS },
		);
		try {
			router.setMemoryPressure(true);
			// When the host drops back below its RSS threshold
			router.setMemoryPressure(false);
			clock = 600;
			router.sweepIdleSessions();
			// Then the full window applies again and the session keeps running
			expect(registry.closes).toEqual([]);
		} finally {
			await router.dispose();
		}
	});
});
