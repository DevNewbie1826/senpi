import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { EvalKernelRunInput } from "../../tool/types.ts";
import type { SessionEnvironment } from "../session-env.ts";
import type { SubprocessSpawn } from "./subprocess-process.ts";

export type KernelRunInput = EvalKernelRunInput;

export type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export interface SubprocessKernelOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Per-session PI_* values merged into the interpreter environment at spawn. */
	readonly sessionEnv?: SessionEnvironment;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}
