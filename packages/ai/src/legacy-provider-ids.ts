export const LEGACY_PROVIDER_IDS = Object.freeze({
	"openai-codex": "chatgpt-subscription",
	"claude-sdk-oauth": "anthropic-subscription",
} as const);

type LegacyProviderId = keyof typeof LEGACY_PROVIDER_IDS;

export function normalizeProviderId(id: string): string {
	if (!Object.hasOwn(LEGACY_PROVIDER_IDS, id)) {
		return id;
	}
	return LEGACY_PROVIDER_IDS[id as LegacyProviderId];
}

export function normalizeModelRef(ref: string): string {
	const slash = ref.indexOf("/");
	if (slash === -1) {
		return normalizeProviderId(ref);
	}
	const provider = ref.slice(0, slash);
	const normalized = normalizeProviderId(provider);
	if (normalized === provider) {
		return ref;
	}
	return `${normalized}/${ref.slice(slash + 1)}`;
}

export function isLegacyProviderId(id: string): boolean {
	return Object.hasOwn(LEGACY_PROVIDER_IDS, id);
}
