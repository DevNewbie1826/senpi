import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { WakeSourceState } from "../extension/wake-source-state.ts";
import type { EvalLanguage, EvalToolDetails } from "./types.ts";

export type EvalDetachedCellState = "queued" | "running" | "detached" | "completed" | "failed" | "cancelled";

export interface EvalDetachedCellSnapshot {
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly startedAtMs: number;
	readonly state: EvalDetachedCellState;
	readonly queuedBehind?: readonly string[];
	readonly outputTail: string;
	readonly result: AgentToolResult<EvalToolDetails>;
	readonly stateRetained: boolean | undefined;
	/** Kernel-supplied detail about the interrupt outcome, e.g. an abandoned blocked worker. */
	readonly interruptNote?: string;
	/** Set only when the wall-clock kill deadline ended this cell. */
	readonly hardLimitSeconds?: number;
	/** Set only when the cell's own execution time exhausted its run budget. */
	readonly runBudgetSeconds?: number;
}

export interface EvalDetachedCellNotification {
	readonly cellId: string;
	readonly content: string;
}

export interface EvalDetachedCellNotifier {
	notify(cells: readonly EvalDetachedCellNotification[]): void;
}

export interface EvalDetachedCellStatusEntry {
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly summary?: string;
	readonly startedAtMs: number;
	readonly queuedBehind?: readonly string[];
}

export interface EvalDetachedCellManagerOptions {
	readonly artifactsDir?: string;
	readonly notifier?: EvalDetachedCellNotifier;
	/** Wall-clock kill deadline in seconds; defaults to the bash-parity 1800s. */
	readonly hardLimitSeconds?: number;
	/** Kill deadline for a cell's own execution time in seconds; a per-call `timeout` replaces it. Defaults to 300s. */
	readonly runBudgetSeconds?: number;
	/** Global detached-cell capacity; defaults to 15. Full capacity keeps new cells foreground. */
	readonly maxDetachedCells?: number;
	readonly onStatusChange?: (entries: readonly EvalDetachedCellStatusEntry[]) => void;
	/** Receives a full per-source liveness snapshot on every detached-cell transition; used by the goal builtin. */
	readonly onWakeSourceState?: (state: WakeSourceState) => void;
	readonly now?: () => number;
}
