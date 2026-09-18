import type { ProviderStreams, SimpleStreamOptions, StreamOptions } from "../types.ts";

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeFunctionTool(tool: unknown): unknown {
	if (!isJsonObject(tool) || tool.type !== "function") return tool;

	if (isJsonObject(tool.parameters) && tool.parameters.type === undefined) {
		return {
			...tool,
			parameters: {
				type: "object",
				...tool.parameters,
			},
		};
	}

	if (!isJsonObject(tool.function)) return tool;
	const parameters = tool.function.parameters;
	if (!isJsonObject(parameters) || parameters.type !== undefined) return tool;

	return {
		...tool,
		function: {
			...tool.function,
			parameters: {
				type: "object",
				...parameters,
			},
		},
	};
}

export function normalizeBaiRequestPayload(payload: unknown): unknown {
	if (!isJsonObject(payload) || !Array.isArray(payload.tools)) return payload;
	const sourceTools = payload.tools;
	const tools = sourceTools.map((tool) => normalizeFunctionTool(tool));
	return tools.some((tool, index) => tool !== sourceTools[index]) ? { ...payload, tools } : payload;
}

function withBaiPayload<T extends StreamOptions | SimpleStreamOptions>(options: T | undefined): T {
	const upstreamTransform = options?.onPayload;
	return {
		...options,
		onPayload: async (payload, model, request) => {
			const transformed = await upstreamTransform?.(payload, model, request);
			return normalizeBaiRequestPayload(transformed ?? payload);
		},
	} as T;
}

export function baiStreams(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => streams.stream(model, context, withBaiPayload(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, withBaiPayload(options)),
	};
}
