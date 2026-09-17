/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
// Host compatibility and upgrade decisions: protocol version + capabilities + ordinal, never a version string
export {
	decideHostAction,
	GENERATION_HANDOFF_CAPABILITY,
	HOST_PROTOCOL_VERSION,
	type HostAction,
	type HostDecision,
	type HostDecisionClient,
	type HostDecisionPolicy,
	type HostDecisionWarning,
	HostEnsureRefusedError,
	type HostProtocolInfo,
	type HostRefusalReason,
	parseHostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./rpc/host-decision.ts";
export {
	createHostDaemonPaths,
	type EnsuredHost,
	type EnsureHostOptions,
	ensureHost,
	type HostDaemonPaths,
	PINNED_HOST_CLIENT_CAPABILITIES,
} from "./rpc/host-ensure.ts";
export {
	isTransportGoneError,
	type ModelInfo,
	RpcClient,
	type RpcClientEvent,
	RpcClientOpenInFlightError,
	type RpcClientOptions,
	type RpcEventListener,
	RpcTransportGoneError,
} from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
