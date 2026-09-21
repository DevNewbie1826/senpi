/**
 * `senpi host ensure|status` against a REAL daemon started by the source CLI.
 *
 * Every assertion here is made from outside the process that is being tested: the JSON line the CLI
 * printed, the exit code it returned, and - for the environment scope - the daemon's own environment
 * as the operating system reports it. Nothing is stubbed, because what is under test is precisely
 * what a client observes when it shells out to this command.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	daemonEnvironmentText,
	hostCliSandbox,
	onlyJsonLine,
	runHostCli,
	sweepHostCliSandboxes,
} from "./host-cli-support.ts";

const STATUS_FIELDS = [
	"capabilities",
	"engineVersion",
	"env_keys",
	"generation",
	"generations",
	"instanceId",
	"launchProfile",
	"open_fds",
	"pid",
	"reachable",
	"rss_mb",
	"sessions",
	"socket",
	"zombies",
];

const SESSION_COUNT_FIELDS = ["foreign_attached", "foreign_retained", "interactive", "retained", "total", "worker"];

afterEach(async () => {
	await sweepHostCliSandboxes();
}, 120_000);

// The daemon is a POSIX process tree with a unix socket; the win32 named-pipe cell of this
// contract runs in the platform's own CI job.
describe.skipIf(process.platform === "win32")("senpi host ensure", () => {
	it("starts a daemon when the agent directory has none", async () => {
		const qa = await hostCliSandbox("start");

		const result = await runHostCli(qa, ["ensure", "--json"]);

		expect(result.exitCode).toBe(0);
		const payload = onlyJsonLine(result);
		expect(payload).toMatchObject({ action: "start", socket: qa.socket, reused: false, upgradeable: true });
		expect(typeof payload.pid).toBe("number");
		expect(typeof payload.instanceId).toBe("string");
		expect(payload.capabilities).toContain("multi_session");
		expect(typeof payload.launchProfileId).toBe("string");
	}, 120_000);

	it("reuses the running daemon when a second ensure finds it", async () => {
		const qa = await hostCliSandbox("reuse");
		const first = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));

		const second = await runHostCli(qa, ["ensure", "--json"]);

		expect(second.exitCode).toBe(0);
		const payload = onlyJsonLine(second);
		expect(payload).toMatchObject({
			action: "reuse",
			reused: true,
			instanceId: first.instanceId,
			pid: first.pid,
		});
	}, 120_000);

	it("gives the daemon the allowlisted environment and nothing else", async () => {
		const qa = await hostCliSandbox("env");

		const ensured = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"], { MY_SECRET_TOKEN: "canary-value" }));

		const environment = daemonEnvironmentText(ensured.pid as number);
		expect(environment).toMatch(/\bHOME=/u);
		expect(environment).toMatch(/\bSENPI_RPC_HOST_DAEMON_DIR=/u);
		// The canary was set on the ensuring process and is outside the allowlist: the daemon that
		// outlives that process must never have been told it.
		expect(environment).not.toContain("MY_SECRET_TOKEN");
		expect(environment).not.toContain("canary-value");
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("senpi host status", () => {
	it("reports the running daemon's identity, occupancy and environment scope", async () => {
		const qa = await hostCliSandbox("status");
		const ensured = onlyJsonLine(await runHostCli(qa, ["ensure", "--json"]));

		const result = await runHostCli(qa, ["status", "--json"]);

		expect(result.exitCode).toBe(0);
		const status = onlyJsonLine(result);
		expect(Object.keys(status).sort()).toEqual(STATUS_FIELDS);
		expect(status).toMatchObject({
			reachable: true,
			socket: qa.socket,
			pid: ensured.pid,
			instanceId: ensured.instanceId,
			generation: 0,
		});
		expect(Object.keys(status.sessions as Record<string, unknown>).sort()).toEqual(SESSION_COUNT_FIELDS);
		expect(status.sessions).toEqual({
			total: 0,
			interactive: 0,
			worker: 0,
			retained: 0,
			foreign_attached: 0,
			foreign_retained: 0,
		});
		// Names only, and only the allowlist: a value never leaves the ensuring process.
		expect(status.env_keys).toContain("HOME");
		expect(status.env_keys).toContain("SENPI_CODING_AGENT_DIR");
		expect(status.env_keys).not.toContain("MY_SECRET_TOKEN");
		expect(status.generations).toHaveLength(1);
		const generation = (status.generations as Record<string, unknown>[])[0];
		expect(Object.keys(generation).sort()).toEqual([
			"alive",
			"current",
			"engineVersion",
			"generation",
			"instanceId",
			"pid",
			"rss_mb",
			"sessions",
		]);
		expect(generation).toMatchObject({
			instanceId: ensured.instanceId,
			generation: 0,
			pid: ensured.pid,
			engineVersion: ensured.engineVersion,
			// The daemon holds nothing, so it claims no session file either.
			sessions: 0,
			current: true,
			alive: true,
		});
		// `number | null` by contract: a platform that cannot answer `ps` still reports the field.
		expect(generation.rss_mb === null || typeof generation.rss_mb === "number").toBe(true);
	}, 120_000);

	it("answers a socket nobody serves with the same shape and a refusal code", async () => {
		const qa = await hostCliSandbox("absent");

		const result = await runHostCli(qa, ["status", "--json"]);

		expect(result.exitCode).toBe(3);
		const status = onlyJsonLine(result);
		expect(Object.keys(status).sort()).toEqual(STATUS_FIELDS);
		expect(status).toMatchObject({ reachable: false, socket: qa.socket, pid: null, generations: [] });
	}, 60_000);
});
