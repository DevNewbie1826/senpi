import type { ModelCost, ThinkingLevelMap } from "../src/types.ts";
import type { Model } from "../src/types.ts";
import baiMetadataJson from "./bai-models.json" with { type: "json" };

export type BaiApi = "openai-responses" | "openai-completions" | "anthropic-messages";

type BaiInput = ("text" | "image" | "video")[];

interface BaiModelMetadata {
	api: BaiApi;
	contextWindow: number;
	maxTokens: number;
	input: BaiInput;
	cost: ModelCost;
	thinkingLevelMap?: ThinkingLevelMap;
}

const BAI_BASE_URL = "https://api.b.ai/v1";
const BAI_ANTHROPIC_BASE_URL = "https://api.b.ai";

const baiMetadata = baiMetadataJson as unknown as Readonly<Record<string, BaiModelMetadata>>;

function formatBaiModelName(modelId: string): string {
	const [family, version, ...rest] = modelId.split("-");
	const familyName: Record<string, string> = {
		claude: "Claude",
		deepseek: "DeepSeek",
		gemini: "Gemini",
		glm: "GLM",
		gpt: "GPT",
		hy3: "HY3",
		hy4: "HY4",
		kimi: "Kimi",
		mimo: "MiMo",
		minimax: "MiniMax",
		"qwen3.8": "Qwen3.8",
	};
	const displayFamily = familyName[family] ?? family.toUpperCase();
	const displayRest = rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");

	if (family === "gpt" || family === "glm") {
		return `${displayFamily}-${version}${displayRest ? ` ${displayRest}` : ""}`;
	}

	const suffix = [version, ...rest]
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
	return suffix ? `${displayFamily} ${suffix}` : displayFamily;
}

/**
 * B.AI `/v1/models` returns credential-scoped IDs without model capabilities.
 * This generated-catalog source pins B.AI's published standard metadata so the
 * runtime provider can filter the catalog by entitlement without guessing.
 *
 * Sources:
 * - https://docs.b.ai/sitemap.xml (`/llmservice/models/*`)
 * - https://docs.b.ai/llmservice/pricing-and-usage/
 */
export function getBaiModels(): Model<BaiApi>[] {
	return Object.entries(baiMetadata).map(([id, metadata]) => ({
		id,
		name: formatBaiModelName(id),
		api: metadata.api,
		provider: "bai",
		baseUrl: metadata.api === "anthropic-messages" ? BAI_ANTHROPIC_BASE_URL : BAI_BASE_URL,
		reasoning: metadata.thinkingLevelMap !== undefined,
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}),
		input: metadata.input,
		cost: metadata.cost,
		contextWindow: metadata.contextWindow,
		maxTokens: metadata.maxTokens,
		...(metadata.api === "openai-completions"
			? {
					compat: {
						supportsDeveloperRole: false,
					},
				}
			: {}),
	}));
}
