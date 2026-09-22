/**
 * The process table through the kernel, for a long-lived daemon's status surface.
 *
 * Why this exists (omo-desktop#594, senpi#1507): a daemon-control surface that reads its
 * metrics by spawning `ps` runs one short-lived probe child per request, at client poll
 * cadence. On runtimes whose `execFile` does not reap (the condition #1507 measured in the
 * wild - 9,386 zombies), every probe becomes a permanent zombie of whichever long-lived
 * process performed the read. The watchdog lost its `ps` probe for exactly this reason
 * (#1721); this module gives the status metrics the same zero-spawn property: one `sysctl`
 * on darwin (the table `ps` itself reads, zombies included), a `/proc/<pid>/stat` scan on
 * linux, and nothing at all on runtimes without the bindings - the caller reports `null`
 * rather than spawning.
 *
 * RUNTIME BOUNDARY (same shape as `child-reaper-syscalls.ts`): the darwin reader needs
 * `bun:ffi`, a Bun-only builtin whose top-level import makes this module unloadable on Node.
 * The specifier is imported behind the runtime gate, so a Node caller gets `undefined` and
 * answers `null`, never a child process.
 */
import { readdirSync, readFileSync } from "node:fs";

/** One row of the whole-table read; `state` is `"Z"` for zombies, `"U"` otherwise. */
export interface ProcessTableRow {
	readonly pid: number;
	readonly ppid: number;
	readonly state: string;
	/** Resident memory in kilobytes; 0 where the kernel reports none (zombies). */
	readonly rssKb: number;
}

/** Reads the whole process table without spawning anything, or `undefined` when it cannot. */
export type ProcessTableReader = () => readonly ProcessTableRow[] | undefined;

type SupportedPlatform = "darwin" | "linux";

function supportedPlatform(platform: string): SupportedPlatform | undefined {
	return platform === "darwin" || platform === "linux" ? platform : undefined;
}

/**
 * Loads the platform reader once per process. Node (and any platform without bindings)
 * resolves to `undefined`: the status surface then reports `null` fields rather than
 * falling back to a `ps` child, because a read that spawns a probe is the bug this module
 * exists to prevent.
 */
export async function loadProcessTableReader(
	platform: NodeJS.Platform = process.platform,
): Promise<ProcessTableReader | undefined> {
	const supported = supportedPlatform(platform);
	if (supported === undefined) return undefined;
	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return undefined;
	const read = supported === "darwin" ? await darwinReader() : linuxReader;
	return read;
}

/** `struct kinfo_proc` fields this reader consumes, byte offsets pinned on darwin arm64. */
const KINFO_PROC_STRIDE = 648;
const KINFO_PID_OFFSET = 40;
const KINFO_PPID_OFFSET = 560;
/** `p_stat`: SZOMB is 5; every live state is a different value. */
const KINFO_STAT_OFFSET = 36;
const SZOMB = 5;
/** `struct proc_taskinfo` `pti_resident_size`, the same field `ps -o rss` reports. */
const PROC_PIDTASKINFO = 4;
const TASKINFO_RESIDENT_OFFSET = 8;
const TABLE_START_BYTES = 1 << 20;
const TABLE_MAX_BYTES = 32 << 20;

async function darwinReader(): Promise<ProcessTableReader | undefined> {
	const { dlopen, FFIType, ptr } = await import("bun:ffi");
	const library = dlopen("libSystem.B.dylib", {
		sysctl: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
			returns: FFIType.i32,
		},
		proc_pidinfo: {
			// The `u_int64_t arg` parameter is flavor-specific and unused by PROC_PIDTASKINFO;
			// the repo's bun:ffi shim has no u64, and a u32 0 fills the register identically.
			args: [FFIType.i32, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32],
			returns: FFIType.i32,
		},
	});
	const mib = new Int32Array([1, 14, 0]); // CTL_KERN, KERN_PROC, KERN_PROC_ALL
	const none = new Uint8Array(1);
	let table = new Uint8Array(TABLE_START_BYTES);
	const length = new Uint32Array(1);
	const taskInfo = new Uint8Array(256);
	const taskView = new DataView(taskInfo.buffer);
	return () => {
		for (let attempt = 0; attempt < 4; attempt++) {
			length[0] = table.byteLength;
			const result = library.symbols.sysctl(ptr(mib), mib.length, ptr(table), ptr(length), ptr(none), 0);
			// ENOMEM reports the needed size through `length`; grow and retry.
			if (result !== 0 && length[0] > table.byteLength) {
				if (length[0] > TABLE_MAX_BYTES) return undefined;
				table = new Uint8Array(length[0]);
				continue;
			}
			if (result !== 0) return undefined;
			const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
			const count = Math.floor(length[0] / KINFO_PROC_STRIDE);
			if (count <= 0) return undefined;
			const rows: ProcessTableRow[] = [];
			for (let index = 0; index < count; index++) {
				const base = index * KINFO_PROC_STRIDE;
				const pid = view.getUint32(base + KINFO_PID_OFFSET, true);
				if (!Number.isInteger(pid) || pid <= 0) continue;
				const state = table[base + KINFO_STAT_OFFSET] === SZOMB ? "Z" : "U";
				taskInfo.fill(0);
				const filled = library.symbols.proc_pidinfo(pid, PROC_PIDTASKINFO, 0, ptr(taskInfo), taskInfo.byteLength);
				const residentBytes = filled > 0 ? Number(taskView.getBigUint64(TASKINFO_RESIDENT_OFFSET, true)) : 0;
				rows.push({
					pid,
					ppid: view.getUint32(base + KINFO_PPID_OFFSET, true),
					state,
					rssKb: Math.round(residentBytes / 1024),
				});
			}
			return rows;
		}
		return undefined;
	};
}

/** `/proc/<pid>/stat`: state is field 3, ppid field 4, rss field 24 in pages. */
function linuxReader(): readonly ProcessTableRow[] | undefined {
	const rows: ProcessTableRow[] = [];
	// The stat file reports rss in pages; node exposes no page size, and every platform this
	// ships on today uses 4 KiB pages. The value feeds an advisory MB figure, not accounting.
	const pageKb = 4;
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		let stat: string | undefined;
		try {
			stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			// The process exited between the directory listing and this read.
			continue;
		}
		// comm is parenthesised and may contain spaces, so parse after its last ')'.
		const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const state = tail[0];
		const ppid = Number(tail[1]);
		if (state === undefined || !Number.isInteger(ppid)) continue;
		const rssPages = Number(tail[21]);
		rows.push({
			pid,
			ppid,
			state,
			rssKb: Number.isFinite(rssPages) ? Math.round(rssPages * pageKb) : 0,
		});
	}
	return rows;
}
