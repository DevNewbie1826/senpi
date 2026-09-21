import type { McpServerConfig } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";

interface RegistryEntry {
	readonly connection: ServerConnection;
	readonly shareable: boolean;
	readonly owners: Map<object, number>;
}

export class HostMcpRegistryError extends Error {
	readonly code = "unknown_owner";
	readonly key: string;

	constructor(key: string) {
		super("Cannot detach an unknown MCP connection owner");
		this.name = "HostMcpRegistryError";
		this.key = key;
	}
}

/** Sharing policy is deliberately disabled until shared lifecycle routing is installed. */
export function shareable(_config: McpServerConfig): boolean {
	return false;
}

/** Host-owned connection leases; standalone services construct their own registry. */
export class HostMcpRegistry {
	readonly #entries = new Map<string, Set<RegistryEntry>>();

	attach(key: string, owner: object, factory: () => ServerConnection, canShare = false): ServerConnection {
		const entries = this.#entries.get(key);
		const owned = entries && [...entries].find((entry) => entry.owners.has(owner));
		if (owned) {
			owned.owners.set(owner, (owned.owners.get(owner) ?? 0) + 1);
			return owned.connection;
		}
		const shared = canShare && entries && [...entries].find((entry) => entry.shareable);
		if (shared) {
			shared.owners.set(owner, 1);
			return shared.connection;
		}
		const connection = factory();
		const entry: RegistryEntry = { connection, shareable: canShare, owners: new Map([[owner, 1]]) };
		if (entries) entries.add(entry);
		else this.#entries.set(key, new Set([entry]));
		return connection;
	}

	async detach(key: string, owner: object): Promise<void> {
		const entries = this.#entries.get(key);
		if (!entries) throw new HostMcpRegistryError(key);
		for (const entry of entries) {
			const count = entry.owners.get(owner);
			if (count === undefined) continue;
			if (count > 1) {
				entry.owners.set(owner, count - 1);
				return;
			}
			entry.owners.delete(owner);
			if (entry.owners.size > 0) return;
			entries.delete(entry);
			if (entries.size === 0) this.#entries.delete(key);
			await entry.connection.dispose();
			return;
		}
		throw new HostMcpRegistryError(key);
	}

	*forEachOwner(key: string): IterableIterator<object> {
		for (const entry of this.#entries.get(key) ?? []) yield* entry.owners.keys();
	}

	size(): number {
		let count = 0;
		for (const entries of this.#entries.values()) count += entries.size;
		return count;
	}
}
