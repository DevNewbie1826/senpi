import { describe, expect, it } from "vitest";
import { createEvalInputSchema } from "../src/tool/types.ts";

describe("eval input schema root shape (#2569)", () => {
	const schema = JSON.parse(JSON.stringify(createEvalInputSchema({ js: true, py: true, rb: false, jl: false })));

	it("avoids an enum inside a root combiner branch", () => {
		expect(schema.anyOf).toBeUndefined();
		expect(schema.oneOf).toBeUndefined();
		expect(schema.allOf).toBeUndefined();
		expect(schema.not).toBeDefined();
	});

	it("keeps cell_id required for peek/stop through the not form", () => {
		expect(schema.not).toEqual({
			properties: { action: { enum: ["peek", "stop"] } },
			required: ["action"],
			not: { required: ["cell_id"] },
		});
	});
});
