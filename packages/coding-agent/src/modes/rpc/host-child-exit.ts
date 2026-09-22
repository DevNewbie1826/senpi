/**
 * HOW THE SUPERVISOR READS ITS CHILD'S EXIT: the verdict, and the durable evidence of it.
 *
 * Split out of `host-lifecycle.ts` because that file is far past the per-file ceiling and this is
 * one cohesive unit - deciding whether the host stopped or died, and recording the deaths.
 */
import { recordHostCrash } from "./host-crash-record.ts";

/**
 * The RPC host exits 0 only through its own clean shutdown path - including its idle/empty-host
 * policy - so that is an intentional stop, not a crash: the supervisor mirrors its own idle exit
 * instead of reporting failure. Any non-zero code or signal stays a crash.
 */
export function classifyChildExit(
	code: number | null,
	signal: NodeJS.Signals | null,
): { reason: string; exitCode: number } {
	if (code === 0 && signal === null) return { reason: "rpc host exited on its own idle policy", exitCode: 0 };
	return { reason: `rpc host process exited unexpectedly (${code ?? signal})`, exitCode: 1 };
}

/**
 * Persist a crash-classified child exit, so a host that dies repeatedly can be COUNTED.
 *
 * `classifyChildExit` already knows the difference between an intentional idle stop and a death,
 * but that verdict only ever reached stderr - and the daemon's stderr log is truncated by the very
 * restart that replaces the dead host, so nothing survived to be counted. A clean idle exit still
 * writes nothing, which is what keeps the record file a crash count rather than a log.
 */
export function noteChildExit(
	daemonDir: string,
	code: number | null,
	signal: NodeJS.Signals | null,
	childStartedAt: number,
	now: number = Date.now(),
): void {
	if (classifyChildExit(code, signal).exitCode === 0) return;
	recordHostCrash(daemonDir, {
		at: new Date(now).toISOString(),
		...(signal === null ? { code: code ?? undefined } : { signal }),
		uptimeMs: Math.max(0, now - childStartedAt),
	});
}
