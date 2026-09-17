#!/usr/bin/env bun
/**
 * Live load + contention proof for ONE real `--listen` socket host.
 *
 * Boots a host the way the daemon runs (`--mode rpc --multi-session --listen
 * unix://...`, whose default session runtime is in-process), points it at the
 * fake model server from `scripts/qa-app-server/lib/env.mjs` through a generated
 * `models.json`, and drives two cells over ONE socket connection:
 *
 *   (i)   SCALE       open `--sessions` sessions, then `list_sessions
 *                     { include_workers: true }`; host threads and RSS before/after.
 *   (iii) CONTENTION  time-to-first-event for one session at a time, then for 50
 *                     sessions streaming at once. The RATIO is reported, never gated:
 *                     wall-clock latency is not a contract this host controls.
 *
 * No real provider is reachable: the only model is `mock/mock-model`, served by a
 * local HTTP server this script owns.
 *
 * Usage:
 *   bun scripts/qa-rpc-socket/load-1000.mjs [--sessions 1000] [--concurrent 50]
 *     [--baseline 20] [--session-runtime in-process|worker] [--out <file.json>]
 *
 * Exit 0 when every open succeeded; exit 1 (with `firstError` in the report) when
 * the host refused one - which is what `--session-runtime worker` does at its cap.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { cleanupAllAndWait, installCleanupHooks, startFakeModelServer, writeMockModelsJson } from "../qa-app-server/lib/env.mjs";
import { trackChild } from "../qa-app-server/lib/cleanup.mjs";

const sessionCount = Number(flag("--sessions") ?? 1000);
const concurrentStreams = Number(flag("--concurrent") ?? 50);
const baselineStreams = Number(flag("--baseline") ?? 20);
const sessionRuntime = flag("--session-runtime");
const outPath = flag("--out");
const packageDir = resolve(import.meta.dirname, "..", "..");
const READY_BUDGET_MS = 60_000;
const COMMAND_BUDGET_MS = 120_000;

installCleanupHooks();

async function main() {
	// Short prefix on purpose: a unix socket path must stay under 104 bytes.
	const scratch = mkdtempSync("/tmp/dh-ld-");
	const agentDir = join(scratch, "agent");
	const cwd = join(scratch, "cwd");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const socketPath = join(scratch, `load-${process.pid}.sock`);
	const fake = await startFakeModelServer([{ text: "load-1000" }]);
	writeMockModelsJson(agentDir, fake);

	const host = spawn(
		"bun",
		[
			join(packageDir, "src", "cli.ts"),
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			`unix://${socketPath}`,
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--provider",
			"mock",
			"--model",
			"mock-model",
			...(sessionRuntime === undefined ? [] : ["--session-runtime", sessionRuntime]),
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: scratch,
				TMPDIR: scratch,
				SENPI_CODING_AGENT_DIR: agentDir,
				OMO_CODING_AGENT_DIR: agentDir,
				SENPI_OFFLINE: "1",
				PI_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	trackChild(host);
	let stderr = "";
	host.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
	await waitFor(() => stderr.includes("senpi rpc listening on"), READY_BUDGET_MS, () => `host never listened: ${stderr}`);

	const client = await connect(socketPath);
	const report = { sessions: 0, errors: 0, sessionRuntime: sessionRuntime ?? "cli-default", hostPid: host.pid };
	try {
		report.threads = { before: threadCount(host.pid) };
		report.rssMb = { before: residentMb(host.pid) };
		const opened = [];
		const openStarted = performance.now();
		for (let index = 0; index < sessionCount; index++) {
			const response = await client.request({ type: "open_session", cwd, kind: "worker", auto_title: false });
			if (response.success !== true) {
				report.errors++;
				report.firstError ??= { index, error: response.error };
				break;
			}
			opened.push(response.data.sessionId);
		}
		report.sessions = opened.length;
		report.openMsPerSession = Math.round(performance.now() - openStarted) / Math.max(1, opened.length);
		report.threads.after = threadCount(host.pid);
		report.threads.perSession = Number(((report.threads.after - report.threads.before) / Math.max(1, opened.length)).toFixed(2));
		report.rssMb.after = residentMb(host.pid);
		report.rssMb.perSession = Number(((report.rssMb.after - report.rssMb.before) / Math.max(1, opened.length)).toFixed(2));
		const listed = await client.request({ type: "list_sessions", include_workers: true });
		report.listed = listed.data.sessions.length;
		report.listMs = listed.elapsedMs;

		if (report.errors === 0) {
			// Every measured session is prompted for the FIRST time: a session reused across
			// samples would answer the tap with the tail of its previous turn.
			const single = [];
			for (let sample = 0; sample < baselineStreams; sample++) {
				const sessionId = opened[sample];
				const settled = client.waitForRecord(sessionId, (record) => record.type === "agent_idle");
				single.push(await client.timeToFirstEvent(sessionId, `baseline ${sample}`));
				await settled;
			}
			const streaming = opened.slice(baselineStreams, baselineStreams + concurrentStreams);
			const settling = streaming.map((sessionId) =>
				client.waitForRecord(sessionId, (record) => record.type === "agent_idle"),
			);
			const concurrent = await Promise.all(
				streaming.map((sessionId) => client.timeToFirstEvent(sessionId, "concurrent")),
			);
			await Promise.all(settling);
			report.ttfePairP95 = { single: percentile(single, 95), concurrent50: percentile(concurrent, 95) };
			report.ttfePairP50 = { single: percentile(single, 50), concurrent50: percentile(concurrent, 50) };
			report.ttfeRatioP95 = Number((report.ttfePairP95.concurrent50 / report.ttfePairP95.single).toFixed(1));
		}
	} finally {
		client.dispose();
		await stopHost(host);
		report.orphans = Number(execFileSync("/bin/sh", ["-c", `pgrep -f load-${process.pid}.sock | wc -l`], { encoding: "utf8" }).trim());
		await fake.stop().catch(() => undefined);
		rmSync(scratch, { recursive: true, force: true });
		report.cleanup = { scratchRemoved: true, hostStopped: true };
	}
	return report;
}

/** One JSONL socket connection: correlated requests plus a per-session event tap. */
async function connect(socketPath) {
	const socket = createConnection(socketPath);
	await new Promise((ready, fail) => {
		socket.once("connect", ready);
		socket.once("error", fail);
	});
	let serial = 0;
	let buffer = "";
	const pending = new Map();
	const taps = new Set();
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const record = JSON.parse(line);
			if (record.id && pending.has(record.id)) {
				pending.get(record.id)(record);
				pending.delete(record.id);
				continue;
			}
			if (!record.sessionId) continue;
			for (const tap of [...taps]) if (tap.sessionId === record.sessionId) tap.accept(record);
		}
	});
	const waitForRecord = (sessionId, accepts) =>
		new Promise((resolve_, reject) => {
			const timer = setTimeout(() => {
				taps.delete(tap);
				reject(new Error(`No matching record from ${sessionId}`));
			}, COMMAND_BUDGET_MS);
			const tap = {
				sessionId,
				accept: (record) => {
					if (!accepts(record)) return;
					clearTimeout(timer);
					taps.delete(tap);
					resolve_(record);
				},
			};
			taps.add(tap);
		});
	const request = (command) => {
		const id = `load-${++serial}`;
		const started = performance.now();
		const answered = new Promise((resolve_, reject) => {
			const timer = setTimeout(() => reject(new Error(`No response for ${command.type} (${id})`)), COMMAND_BUDGET_MS);
			pending.set(id, (record) => {
				clearTimeout(timer);
				resolve_({ ...record, elapsedMs: Number((performance.now() - started).toFixed(2)) });
			});
		});
		socket.write(`${JSON.stringify({ ...command, id })}\n`);
		return answered;
	};
	return {
		request,
		waitForRecord,
		/** Milliseconds from issuing the prompt to that session's first streamed record. */
		async timeToFirstEvent(sessionId, message) {
			const started = performance.now();
			const first = waitForRecord(sessionId, () => true).then(() => performance.now() - started);
			const response = await request({ type: "prompt", sessionId, message });
			if (response.success !== true) throw new Error(`prompt failed: ${JSON.stringify(response)}`);
			return first;
		},
		dispose: () => socket.destroy(),
	};
}

async function stopHost(host) {
	if (host.exitCode !== null) return;
	const exited = new Promise((done) => host.once("close", done));
	host.kill("SIGTERM");
	const deadline = setTimeout(() => host.kill("SIGKILL"), 15_000);
	await exited;
	clearTimeout(deadline);
}

function waitFor(condition, budgetMs, describe) {
	return new Promise((ready, fail) => {
		const deadline = Date.now() + budgetMs;
		const poll = () => {
			if (condition()) return ready();
			if (Date.now() > deadline) return fail(new Error(describe()));
			setTimeout(poll, 50);
		};
		poll();
	});
}

function percentile(samples, rank) {
	const sorted = [...samples].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
	return Number((sorted[index] ?? Number.NaN).toFixed(2));
}

function threadCount(pid) {
	return execFileSync("ps", ["-M", String(pid)], { encoding: "utf8" }).trim().split("\n").length - 1;
}

function residentMb(pid) {
	return Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024);
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

let report;
let failure;
try {
	report = await main();
} catch (error) {
	failure = error instanceof Error ? error.stack : String(error);
	report = { sessions: 0, errors: 1, failure };
}
await cleanupAllAndWait();
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outPath) writeFileSync(outPath, serialized);
process.stdout.write(serialized);
process.exit(report.errors === 0 ? 0 : 1);
