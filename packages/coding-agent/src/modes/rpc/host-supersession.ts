/**
 * Noticing that this generation stopped owning its endpoint.
 *
 * A handoff ASKS the predecessor to drain (SIGUSR1), and that request can simply not arrive: an
 * owner whose registration cannot be proven is never signalled, a client that binds its own entry
 * over the path sends nothing at all, and a wedged process can miss the signal it was sent. The
 * generation is then unreachable - the public name resolves to somebody else's socket - while it
 * still holds every retained session and every session-path claim it ever published. That is how
 * one machine ended up with three supervisors on one endpoint, the superseded pair holding
 * gigabytes of sessions no client could reach (#1893).
 *
 * The evidence needs no cooperation from whoever replaced it: the entry at the public path is no
 * longer the socket this generation bound. That is checked here, on a slow unref'd timer, and it
 * fires exactly once - the caller's drain is not idempotent bookkeeping, it is a lifecycle
 * transition.
 */
import { type SocketFileIdentity, socketEntryReplaced } from "./socket-ownership.ts";

/** How often a generation re-checks that the public path still holds the socket it bound. */
export const SUPERSESSION_POLL_MS = 1_000;

export interface SupersededEndpoint {
	/** The public path this generation serves: the supervisor's, not a private internal hop. */
	readonly path: string;
	/** The entry it bound there. Without one, supersession can never be proven and is never claimed. */
	readonly identity: SocketFileIdentity | undefined;
	/** Consulted every tick; a host already draining or shutting down has nothing left to notice. */
	readonly settled?: () => boolean;
}

/** Runs `onSuperseded` once another socket entry holds this endpoint. Returns a stop function. */
export function watchForSupersession(endpoint: SupersededEndpoint, onSuperseded: () => void): () => void {
	if (endpoint.identity === undefined || process.platform === "win32") return () => {};
	const timer = setInterval(() => {
		if (endpoint.settled?.() === true) return;
		void socketEntryReplaced(endpoint.path, endpoint.identity).then((replaced) => {
			if (!replaced || endpoint.settled?.() === true) return;
			stop();
			onSuperseded();
		}, ignore);
	}, SUPERSESSION_POLL_MS);
	// Unref'd: noticing a supersession must never be the reason a process stays up.
	timer.unref?.();
	const stop = (): void => clearInterval(timer);
	return stop;
}

function ignore(): void {}
