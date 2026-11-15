import { onPlanUsageChanged, planUsageStates, refreshPlanUsage } from "../../providers/plan-usage/sources.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

/** A reading younger than this is not asked for again when the page does not say how fresh it needs it. */
const DEFAULT_MAX_AGE_MS = 60_000;
/** Several changes within this time (one refresh often touches a source more than once) reach the pages as one event. */
const BROADCAST_DELAY_MS = 50;

function optionalMaxAge(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new HttpError(400, "maxAgeMs must be a number that is 0 or more");
	}
	return value;
}

/**
 * What is left of the subscription plans behind the providers (the Claude Code and agy plugins register them). The
 * numbers belong to the process, not to a chat: these routes need no slot, and the `plan_usage` event goes to every page.
 *
 * Returns the function that stops listening for changes.
 */
export function registerPlanUsageRoutes(server: WebHttpServer): () => void {
	server.route("GET", "/api/plan-usage", () => ({ sources: planUsageStates() }));

	// Reading takes seconds (the program is started), so the page gets the numbers as they are now and the new ones
	// arrive through the event.
	server.route("POST", "/api/plan-usage/refresh", ({ body }) => {
		if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) {
			throw new HttpError(400, "Expected a JSON object");
		}
		const input = (body ?? {}) as { id?: unknown; maxAgeMs?: unknown };
		if (input.id !== undefined && typeof input.id !== "string") throw new HttpError(400, "id must be a string");
		const maxAgeMs = optionalMaxAge(input.maxAgeMs) ?? DEFAULT_MAX_AGE_MS;
		// refreshPlanUsage never rejects, so nothing is left unhandled here.
		void refreshPlanUsage({ ...(input.id !== undefined ? { id: input.id } : {}), maxAgeMs });
		return { sources: planUsageStates() };
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSent: string | undefined;
	const stopListening = onPlanUsageChanged(() => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			const sources = planUsageStates();
			// A change that leaves what the pages show as it was (a source told us twice) is not worth an event.
			const text = JSON.stringify(sources);
			if (text === lastSent) return;
			lastSent = text;
			server.broadcast("plan_usage", { sources });
		}, BROADCAST_DELAY_MS);
	});
	return () => {
		stopListening();
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
}
