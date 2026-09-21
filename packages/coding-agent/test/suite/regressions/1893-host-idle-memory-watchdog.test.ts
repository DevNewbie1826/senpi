// Regression for senpi issue #1893: a host reported `memory pressure rssMb=9787 sessions=6` over and
// over while a superseded generation beside it held gigabytes with NO session - the state nothing
// ever named, because the sampler only reported pressure, never pressure with nothing to show for it.
import { describe, expect, it } from "vitest";
import { HostMemorySampler } from "../../../src/modes/rpc/host-memory-sampler.ts";

const MEGABYTE = 1024 * 1024;

describe("the host memory watchdog", () => {
	it("reports an empty host above the threshold once per pressure episode", () => {
		const idle: number[] = [];
		let rssMb = 9_000;
		let sessions = 0;
		const sampler = sampleWith({
			readRssBytes: () => rssMb * MEGABYTE,
			sessions: () => sessions,
			onIdlePressure: (value) => idle.push(value),
		});

		sampler.sample();
		sampler.sample();
		expect(idle).toEqual([9_000]);

		sessions = 1;
		sampler.sample();
		sessions = 0;
		rssMb = 9_100;
		sampler.sample();

		expect(idle).toEqual([9_000, 9_100]);
	});

	it("says nothing while the host is below the threshold or holding sessions", () => {
		const idle: number[] = [];
		let rssMb = 100;
		let sessions = 3;
		const sampler = sampleWith({
			readRssBytes: () => rssMb * MEGABYTE,
			sessions: () => sessions,
			onIdlePressure: (value) => idle.push(value),
		});

		sampler.sample();
		rssMb = 9_000;
		sampler.sample();
		sessions = 0;
		rssMb = 100;
		sampler.sample();

		expect(idle).toEqual([]);
	});
});

function sampleWith(options: {
	readRssBytes: () => number;
	sessions: () => number;
	onIdlePressure: (rssMb: number) => void;
}): HostMemorySampler {
	return new HostMemorySampler({
		emit: () => {},
		onPressure: () => {},
		log: () => {},
		env: { SENPI_RPC_HOST_RSS_WARN_MB: "4096" },
		...options,
	});
}
