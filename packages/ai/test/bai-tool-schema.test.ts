import { describe, expect, it } from "vitest";
import { normalizeBaiRequestPayload } from "../src/providers/bai-stream.ts";

describe("B.AI tool schema compatibility", () => {
	it("adds an object root to Responses function schemas without mutating the source", () => {
		const payload = {
			model: "gpt-5.6-sol",
			tools: [
				{
					type: "function",
					name: "workpool",
					parameters: {
						anyOf: [
							{
								type: "object",
								properties: { op: { type: "string", const: "create" } },
							},
							{
								type: "object",
								properties: { op: { type: "string", const: "inspect" } },
							},
						],
					},
				},
				{
					type: "function",
					name: "read",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
		};

		const normalized = normalizeBaiRequestPayload(payload);

		expect(normalized).toEqual({
			...payload,
			tools: [
				{
					...payload.tools[0],
					parameters: {
						type: "object",
						...payload.tools[0].parameters,
					},
				},
				payload.tools[1],
			],
		});
		expect(payload.tools[0]?.parameters).not.toHaveProperty("type");
	});

	it("normalizes Chat Completions function schemas nested under function", () => {
		const payload = {
			tools: [
				{
					type: "function",
					function: {
						name: "workpool",
						parameters: {
							oneOf: [{ type: "object", properties: { op: { const: "create" } } }],
						},
					},
				},
			],
		};

		expect(normalizeBaiRequestPayload(payload)).toMatchObject({
			tools: [
				{
					function: {
						parameters: {
							type: "object",
							oneOf: payload.tools[0]?.function.parameters.oneOf,
						},
					},
				},
			],
		});
	});
});
