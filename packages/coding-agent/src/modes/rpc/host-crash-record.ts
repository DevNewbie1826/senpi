/**
 * Durable evidence that a supervised RPC host child DIED rather than stopped.
 *
 * The supervisor already knows the difference - `classifyChildExit` in `host-lifecycle.ts`
 * separates a clean idle exit from a crash - but it only ever reported the crash to stderr, and
 * the daemon's stderr log is truncated by the very restart that replaces the dead host. A host
 * dying every fifty minutes was therefore indistinguishable, from inside senpi, from one that had
 * never died at all.
 *
 * This file is append-only and lives beside the other per-endpoint daemon state, so a restart adds
 * to it instead of replacing it. It records crashes and ONLY crashes: a clean idle exit writes
 * nothing, which is what makes the line count a crash count.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Crash records kept per endpoint. A crash loop rewrites the file down to this many. */
export const HOST_CRASH_RECORD_LIMIT = 50;

/** Written 0600 like every other daemon state file: it names local paths and process detail. */
const CRASH_RECORD_FILE_MODE = 0o600;

/** `<daemonDir>/crashes.jsonl` - one JSON object per line, oldest first. */
export function hostCrashRecordFile(daemonDir: string): string {
	return join(daemonDir, "crashes.jsonl");
}

export interface HostCrashRecord {
	/** ISO-8601 instant the supervisor observed the death. */
	readonly at: string;
	/** The signal that killed the child, when it died from one. */
	readonly signal?: string;
	/** The non-zero exit code, when it exited rather than signalled. */
	readonly code?: number;
	/** How long the child had been alive, in milliseconds. */
	readonly uptimeMs: number;
}

/**
 * Append one crash record, then bound the file.
 *
 * NEVER throws: this runs on the supervisor's exit path, where a filesystem failure must not be
 * able to delay or prevent the shutdown it is only annotating.
 */
export function recordHostCrash(daemonDir: string, record: HostCrashRecord): void {
	try {
		mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
		appendFileSync(hostCrashRecordFile(daemonDir), `${JSON.stringify(record)}\n`, { mode: CRASH_RECORD_FILE_MODE });
		pruneHostCrashRecords(daemonDir);
	} catch {
		// Evidence is best-effort; the shutdown it annotates is not.
	}
}

/** Every record currently held, oldest first. Unparseable lines are skipped, never thrown on. */
export function readHostCrashRecords(daemonDir: string): readonly HostCrashRecord[] {
	let raw: string;
	try {
		raw = readFileSync(hostCrashRecordFile(daemonDir), "utf8");
	} catch {
		return [];
	}
	const records: HostCrashRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && typeof Reflect.get(value, "at") === "string") {
				records.push(value as HostCrashRecord);
			}
		} catch {
			// A torn final line from a host killed mid-append is not a reason to lose the rest.
		}
	}
	return records;
}

/** Keep the newest `HOST_CRASH_RECORD_LIMIT` records so a crash loop cannot grow the file forever. */
function pruneHostCrashRecords(daemonDir: string): void {
	const records = readHostCrashRecords(daemonDir);
	if (records.length <= HOST_CRASH_RECORD_LIMIT) return;
	const kept = records.slice(records.length - HOST_CRASH_RECORD_LIMIT);
	writeFileSync(hostCrashRecordFile(daemonDir), `${kept.map((r) => JSON.stringify(r)).join("\n")}\n`, {
		mode: CRASH_RECORD_FILE_MODE,
	});
}
