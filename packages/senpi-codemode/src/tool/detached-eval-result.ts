import type { AgentToolResult } from "@code-yeongyu/senpi";
import type {
	EvalDetachedCellManager,
	EvalDetachedCellSnapshot,
	EvalDetachedCellState,
} from "./detached-cell-manager.ts";
import { interruptionStateNote } from "./interrupt-note.ts";
import type { EvalCellResult, EvalControlInput, EvalToolDetails, EvalToolInput } from "./types.ts";

export async function executeEvalControl(
	cellManager: EvalDetachedCellManager,
	request: EvalControlInput,
): Promise<AgentToolResult<EvalToolDetails>> {
	const snapshot =
		request.action === "stop" ? await cellManager.stop(request.cell_id) : cellManager.peek(request.cell_id);
	return createDetachedControlResult(snapshot);
}

export function resultAfterDetach(
	snapshot: EvalDetachedCellSnapshot,
	input: EvalToolInput,
): AgentToolResult<EvalToolDetails> {
	if (snapshot.state !== "detached" && snapshot.state !== "running") return createDetachedControlResult(snapshot);
	return {
		content: [
			{
				type: "text",
				text: `Eval cell ${snapshot.cellId} detached and is still running in the ${input.language} kernel. Completion will arrive as a notification. Use eval({ action: "peek", cell_id: "${snapshot.cellId}" }) or eval({ action: "stop", cell_id: "${snapshot.cellId}" }).`,
			},
		],
		details: snapshot.result.details,
	};
}

export function createDetachedControlResult(snapshot: EvalDetachedCellSnapshot): AgentToolResult<EvalToolDetails> {
	const terminationNote =
		snapshot.state === "cancelled" ? interruptionStateNote(snapshot.language, snapshot.stateRetained) : undefined;
	const output = textContent(snapshot.result);
	const text = [
		`Eval cell ${snapshot.cellId} (${snapshot.language}) is ${snapshot.state}.`,
		output.length === 0 ? "(no buffered output)" : output,
		...(terminationNote === undefined ? [] : [terminationNote]),
		...(snapshot.interruptNote === undefined ? [] : [snapshot.interruptNote.trim()]),
	].join("\n");
	return {
		content: [{ type: "text", text }, ...snapshot.result.content.filter((part) => part.type === "image")],
		details: {
			...snapshot.result.details,
			...(snapshot.state === "failed" ? { isError: true } : {}),
		},
	};
}

export function resultForDetachedState(
	result: AgentToolResult<EvalToolDetails>,
	state: EvalDetachedCellState,
	durationMs: number,
	queuedBehind?: readonly string[],
): AgentToolResult<EvalToolDetails> {
	const details = result.details;
	const cells = details.cells ?? [];
	const nextCells =
		cells.length === 0
			? []
			: cells.map((cell, index) => {
					if (index !== 0) return { ...cell };
					const { queuedBehind: _previousQueue, ...current } = cell;
					return {
						...current,
						durationMs: terminalDuration(cell, state, durationMs),
						status: cellStatus(state),
						...(queuedBehind === undefined ? {} : { queuedBehind }),
					};
				});
	return {
		content: result.content.map((part) => ({ ...part })),
		details: {
			...details,
			durationMs: terminalDuration(details, state, durationMs),
			toolCalls: details.toolCalls.map((toolCall) => ({ ...toolCall })),
			...(details.statusEvents === undefined
				? {}
				: {
						statusEvents: details.statusEvents.map((event) => ({
							...event,
						})),
					}),
			...(nextCells.length === 0
				? {}
				: {
						cells: nextCells.map((cell) => ({
							...cell,
							...(cell.statusEvents === undefined
								? {}
								: {
										statusEvents: cell.statusEvents.map((event) => ({
											...event,
										})),
									}),
						})),
					}),
			...(details.jsonOutputs === undefined ? {} : { jsonOutputs: structuredClone(details.jsonOutputs) }),
		},
	};
}

function textContent(result: AgentToolResult<EvalToolDetails>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function terminalDuration(
	value: { readonly durationMs?: number },
	state: EvalDetachedCellState,
	liveDurationMs: number,
): number {
	if (state === "completed" || state === "failed" || state === "cancelled") return value.durationMs ?? liveDurationMs;
	return liveDurationMs;
}

function cellStatus(state: EvalDetachedCellState): EvalCellResult["status"] {
	switch (state) {
		case "queued":
			return "queued";
		case "running":
			return "running";
		case "detached":
			return "detached";
		case "completed":
			return "complete";
		case "failed":
			return "error";
		case "cancelled":
			return "cancelled";
	}
}
