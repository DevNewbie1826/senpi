import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { EvalKernelRunInput } from "../../tool/types.ts";
import type { SessionEnvironment } from "../session-env.ts";

export type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export type JavaScriptKernelMode = "worker" | "inline";

/** Snapshot or live provider consulted when the worker registry checks collisions. */
export type KernelToolNameSource = readonly string[] | (() => readonly string[]);

export function resolveKernelToolNameSource(names?: KernelToolNameSource): string[] {
	if (typeof names === "function") return [...names()];
	return names === undefined ? [] : [...names];
}

export interface JavaScriptKernelOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly parallelPoolWidth: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly workerEntryUrl?: URL;
	/** Per-session PI_* values applied to the worker environment before the first cell runs. */
	readonly sessionEnv?: SessionEnvironment;
	/** Host tool names denied as JS kernel-tool identifiers (init protocol). */
	readonly hostToolNames?: KernelToolNameSource;
	/** Tool names registered in another kernel language, denied as JS kernel-tool identifiers. */
	readonly foreignLanguageNames?: KernelToolNameSource;
}

export type JavaScriptRunInput = EvalKernelRunInput;

export type KernelOperation = "run" | "reset" | "interrupt";
export type LifecycleState = "open" | "closing" | "closed";

export class JavaScriptKernelClosedError extends Error {
	readonly name = "JavaScriptKernelClosedError";
	readonly operation: KernelOperation;

	constructor(operation: KernelOperation) {
		super(`Cannot ${operation}: JavaScript kernel is closed`);
		this.operation = operation;
	}
}

export function assertJavaScriptKernelOpen(lifecycle: LifecycleState, operation: KernelOperation): void {
	if (lifecycle !== "open") throw new JavaScriptKernelClosedError(operation);
}
