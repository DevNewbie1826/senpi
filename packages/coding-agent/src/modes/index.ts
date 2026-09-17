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
	type HostUpgradePolicy,
	PINNED_HOST_CLIENT_CAPABILITIES,
} from "./rpc/host-ensure.ts";
// Replacing a running daemon without ending its work: the drain-based generation handoff,
// the identity probe every decision starts from, and the two ways a generation is ended.
export {
	type HandoffHostOptions,
	type HandoffRefusal,
	type HandoffResult,
	handoffHost,
	type StopHostOptions,
	type StopHostResult,
	stopHost,
} from "./rpc/host-handoff.ts";
export { type ProbeHostOptions, probeHost } from "./rpc/host-probe.ts";
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
