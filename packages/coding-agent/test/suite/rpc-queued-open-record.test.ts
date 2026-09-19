import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

/**
 * senpi#1844: the in-process daemon serializes concurrent open_session, so a burst crosses the
 * 30 s open deadline and the client sees only "Timeout waiting for response to open_session.
 * Stderr: " - nothing after it. A queued open must tell its client WHERE it is, before the open
 * enters the loop, so a deadline miss can name its cause instead of arriving as silence.
 *
 * The record carries the requester's id under `for_request`, never under the response-id field:
 * a desktop client settles pending requests by response id, and a queued record wearing the
 * open's id would be taken as the open's reply.
 */
describe("open_session queued record", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rpc-queued-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("tells the opener its queue position before the open completes", async () => {
		await using rig = createInProcessRig(dir);
		const cwd = join(dir, "p");
		const reply = await rig.open("c1", { cwd, sessionPath: join(dir, "s1.jsonl") });
		expect(reply?.type).not.toBe("error");

		const queued = rig.recordsFor("c1").find((record) => record.type === "queued");
		expect(queued).toBeDefined();
		expect(queued?.for_request).toBe("open-1");
		expect(queued?.position).toBe(1);
		// A queued record must never wear the response-id field, or a client settles the open with it.
		expect(queued?.id).toBeUndefined();
	});

	it("gives every concurrent opener its own record, never wearing the response id", async () => {
		await using rig = createInProcessRig(dir);
		const cwd = join(dir, "p");
		// Fire both without awaiting the first: the fake runtime is fast, so the order in which
		// they enter the barrier is not pinned - but each MUST receive a queued record with its
		// own for_request, and position is 1-based.
		await Promise.all([
			rig.open("c1", { cwd, sessionPath: join(dir, "s1.jsonl") }),
			rig.open("c2", { cwd, sessionPath: join(dir, "s2.jsonl") }),
		]);

		for (const [connection, request] of [
			["c1", "open-1"],
			["c2", "open-2"],
		] as const) {
			const queued = rig.recordsFor(connection).find((record) => record.type === "queued");
			expect(queued, `${connection} received no queued record`).toBeDefined();
			expect(queued?.for_request).toBe(request);
			expect(typeof queued?.position).toBe("number");
			expect(queued?.position as number).toBeGreaterThanOrEqual(1);
			expect(queued?.id).toBeUndefined();
		}
	});
});
