import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERSESSION_POLL_MS, watchForSupersession } from "../../../src/modes/rpc/host-supersession.ts";
import { type SocketFileIdentity, statSocketIdentity } from "../../../src/modes/rpc/socket-ownership.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 30_000);

async function boundEndpoint(): Promise<{ path: string; identity: SocketFileIdentity }> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-endpoint-absent-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "rpc.sock");
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const identity = await statSocketIdentity(path);
	if (identity === undefined) throw new Error(`${path}: a bound socket must have an identity`);
	return { path, identity };
}

async function runPolls(count: number): Promise<void> {
	for (let poll = 0; poll < count; poll++) await vi.advanceTimersByTimeAsync(SUPERSESSION_POLL_MS);
}

describe("issue 1961: a generation that lost its public entry", () => {
	it("notices the loss, so it can drain instead of living on unreachable", async () => {
		// given: a generation serving the public endpoint whose entry it bound
		const endpoint = await boundEndpoint();
		let lost = 0;
		vi.useFakeTimers();
		const stop = watchForSupersession({ path: endpoint.path, identity: endpoint.identity }, () => {
			lost += 1;
		});
		cleanups.push(async () => stop());

		// when: the bound name is removed, so nothing can resolve the endpoint any more
		await unlink(endpoint.path);
		await runPolls(6);

		// then: the generation learns it stopped owning its endpoint, exactly once
		expect(lost).toBe(1);
	}, 30_000);
});
