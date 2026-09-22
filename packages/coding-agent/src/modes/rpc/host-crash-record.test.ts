import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noteChildExit } from "./host-child-exit.ts";
import {
	HOST_CRASH_RECORD_LIMIT,
	hostCrashRecordFile,
	readHostCrashRecords,
	recordHostCrash,
} from "./host-crash-record.ts";

/**
 * senpi#1950: the supervisor already separated a crashed child from a clean idle exit and then
 * reported the crash only to stderr - which the next host start truncates. A host dying hourly
 * left nothing countable behind, so every investigation had to correlate OS crash reports by hand.
 */
const directories: string[] = [];
const daemonDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "senpi-crash-record-"));
	directories.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Drives the REAL seam the supervisor's exit handler calls, so removing that call or inverting the
 * crash condition fails these tests. A local re-implementation would pass either way.
 */
const observeChildExit = (dir: string, code: number | null, signal: NodeJS.Signals | null, uptimeMs: number): void => {
	const now = Date.now();
	noteChildExit(dir, code, signal, now - uptimeMs, now);
};

describe("host crash records", () => {
	it("keeps the first crash readable after a replacement host starts", () => {
		const dir = daemonDir();
		observeChildExit(dir, null, "SIGBUS", 3_061_000);

		// A replacement generation boots and writes its own daemon state. This is exactly the
		// moment the stderr log was lost, so it is the moment the record has to survive.
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ coldStart: "transient" }));

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.signal).toBe("SIGBUS");
		expect(records[0]?.uptimeMs).toBe(3_061_000);
	});

	it("accumulates repeated crashes in order so they can be counted", () => {
		const dir = daemonDir();
		observeChildExit(dir, null, "SIGSEGV", 5_000);
		observeChildExit(dir, null, "SIGBUS", 9_000);

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(2);
		expect(records.map((record) => record.signal)).toEqual(["SIGSEGV", "SIGBUS"]);
	});

	it("records a non-zero exit code when the child exited instead of signalling", () => {
		const dir = daemonDir();
		observeChildExit(dir, 1, null, 1_500);

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.code).toBe(1);
		expect(records[0]?.signal).toBeUndefined();
	});

	it("writes nothing for a clean idle exit, so the line count is a crash count", () => {
		const dir = daemonDir();
		observeChildExit(dir, 0, null, 900_000);

		expect(readHostCrashRecords(dir)).toEqual([]);
		expect(() => readFileSync(hostCrashRecordFile(dir), "utf8")).toThrow();
	});

	it("bounds the file so a crash loop cannot grow it forever", () => {
		const dir = daemonDir();
		for (let index = 0; index < HOST_CRASH_RECORD_LIMIT + 10; index++) {
			recordHostCrash(dir, { at: new Date().toISOString(), signal: "SIGBUS", uptimeMs: index });
		}

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(HOST_CRASH_RECORD_LIMIT);
		// Pruning keeps the NEWEST: the oldest uptimes are the ones that must be gone.
		expect(records[0]?.uptimeMs).toBe(10);
		expect(records.at(-1)?.uptimeMs).toBe(HOST_CRASH_RECORD_LIMIT + 9);
	});

	it("survives an unwritable directory rather than throwing into the shutdown path", () => {
		expect(() =>
			recordHostCrash(join("/nonexistent-root-for-senpi-1950", "daemon"), {
				at: new Date().toISOString(),
				signal: "SIGBUS",
				uptimeMs: 1,
			}),
		).not.toThrow();
	});

	it("skips a torn final line from a host killed mid-append", () => {
		const dir = daemonDir();
		recordHostCrash(dir, { at: new Date().toISOString(), signal: "SIGSEGV", uptimeMs: 42 });
		writeFileSync(hostCrashRecordFile(dir), `${readFileSync(hostCrashRecordFile(dir), "utf8")}{"at":"tru`);

		const records = readHostCrashRecords(dir);
		expect(records).toHaveLength(1);
		expect(records[0]?.uptimeMs).toBe(42);
	});
});
