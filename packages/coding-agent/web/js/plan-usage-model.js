// Plan limits (what is left of the agy and Claude subscriptions): the decisions behind the composer's meter, kept free of the
// DOM and the store so they can be tested on their own. A source is { id, label, groups, observedAt?, refreshing?,
// unavailable?, error?, nextRefreshAt? }; a group is { label, modelIds?, windows }; a window is { kind, leftPercent, resetsAt? }
// (leftPercent is what is LEFT, 0-100; resetsAt is a ms epoch, unset while the window has not started counting).

export const WINDOW_KINDS = ["five_hour", "weekly"];

/** A reading older than this without a refresh, or a reset time this far in the past, asks for a new read. */
const RESET_GRACE_MS = 10_000;
/** A window with this much left has most likely not started counting yet (the program reports 100% until the next request). */
const IDLE_PERCENT = 99.5;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const windowsOf = (group) => (Array.isArray(group?.windows) ? group.windows : []);
const readable = (window) => !!window && WINDOW_KINDS.includes(window.kind) && finite(window.leftPercent);
const expired = (window, now) => finite(window.resetsAt) && window.resetsAt <= now;

/** A source is usable when it has at least one reading of a known kind. */
export function usable(source) {
	return Array.isArray(source?.groups) && source.groups.some((group) => windowsOf(group).some(readable));
}

/** Whether the meter has anything to show for these sources: a reading, or the reason there is none. */
export function worthShowing(sources) {
	return Array.isArray(sources) && sources.some((source) => usable(source) || !!source?.unavailable || !!source?.error);
}

/**
 * The source the collapsed meter speaks for. The provider of the chat's model wins, because that is the plan the next
 * request spends; a chat on a model of some other provider shows the usable source with the least five-hour room left
 * (the one closest to running out), or the first usable one when none has a five-hour reading.
 */
export function focusSource(sources, model, now = Date.now()) {
	const list = Array.isArray(sources) ? sources : [];
	if (model?.provider) {
		const own = list.find((source) => source?.id === model.provider);
		if (own) return own;
	}
	let best;
	let bestLeft = Infinity;
	for (const source of list) {
		if (!usable(source)) continue;
		for (const group of source.groups)
			for (const window of windowsOf(group)) {
				if (window.kind !== "five_hour" || !readable(window) || expired(window, now)) continue;
				if (window.leftPercent < bestLeft) [best, bestLeft] = [source, window.leftPercent];
			}
	}
	return best ?? list.find(usable);
}

/**
 * The two windows the collapsed meter shows: for each kind the reading with the least left among the groups that apply.
 * `modelId` is the chat's model when the chat is on this source's provider; without it (the chat is elsewhere) only the
 * plan-wide group (label '') counts, or every group when the plan has no such group. A group without `modelIds` applies
 * to every model. A window whose reset time has passed is stale and ignored.
 */
export function focusWindows(source, modelId, now = Date.now()) {
	const groups = Array.isArray(source?.groups) ? source.groups : [];
	let applying;
	if (modelId) applying = groups.filter((group) => !Array.isArray(group.modelIds) || group.modelIds.includes(modelId));
	else {
		const planWide = groups.filter((group) => !group.label);
		applying = planWide.length ? planWide : groups;
	}
	const found = {};
	for (const group of applying)
		for (const window of windowsOf(group)) {
			if (!readable(window) || expired(window, now)) continue;
			const kept = found[window.kind];
			// On a tie the reading that knows its reset time is the more useful one to show.
			if (!kept || window.leftPercent < kept.leftPercent || (window.leftPercent === kept.leftPercent && !finite(kept.resetsAt) && finite(window.resetsAt))) found[window.kind] = window;
		}
	return found;
}

/** 'counting' (a reset time ahead), 'expired' (it has passed), 'idle' (full and not started) or 'unknown' (no reset time). */
export function windowState(window, now = Date.now()) {
	if (finite(window?.resetsAt)) return window.resetsAt <= now ? "expired" : "counting";
	return window?.leftPercent >= IDLE_PERCENT ? "idle" : "unknown";
}

/** The colour class of a percent left: 'danger' below 10, 'warn' below 25, else ''. */
export function level(leftPercent) {
	if (!finite(leftPercent)) return "";
	return leftPercent < 10 ? "danger" : leftPercent < 25 ? "warn" : "";
}

/** The worse of several levels, for the button that covers two windows. */
export function worstLevel(levels) {
	return levels.includes("danger") ? "danger" : levels.includes("warn") ? "warn" : "";
}

/** A percent left as it is drawn: rounded and kept inside 0-100. */
export function percentOf(leftPercent) {
	return finite(leftPercent) ? Math.round(Math.max(0, Math.min(100, leftPercent))) : null;
}

/** Whole days, hours and minutes of a duration, rounded down; the finest step is one minute. */
export function countdownParts(ms) {
	const minutes = finite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
	return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

/** A duration in words: '5 d 6 h', '4 h 41 min', '41 min', 'less than 1 min'. `t` is the translate function of the caller. */
export function formatCountdown(ms, t) {
	const { days, hours, minutes } = countdownParts(ms);
	if (days > 0) return t("{d} d {h} h", { d: days, h: hours });
	if (hours > 0) return t("{h} h {m} min", { h: hours, m: minutes });
	if (minutes > 0) return t("{m} min", { m: minutes });
	return t("less than 1 min");
}

/** Local wall-clock time of a reset: 'HH:mm' when it is today, otherwise the weekday and 'HH:mm'. */
export function resetClock(resetsAt, now = Date.now(), locale) {
	const at = new Date(resetsAt);
	const pad = (n) => String(n).padStart(2, "0");
	const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	const today = new Date(now);
	if (at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()) return clock;
	return `${new Intl.DateTimeFormat(locale || undefined, { weekday: "short" }).format(at)} ${clock}`;
}

/** Whole minutes since a reading, 0 for 'just now'. */
export function minutesSince(observedAt, now = Date.now()) {
	return finite(observedAt) ? Math.max(0, Math.floor((now - observedAt) / 60_000)) : null;
}

/**
 * Whether asking the server again is worth it: a source that can be read has no reading yet, a reading older than
 * `maxAgeMs`, or a window whose reset time passed more than 10 seconds ago (its numbers are from before the reset). A
 * source that is being read right now, or that the server will not read again before `nextRefreshAt`, never asks.
 */
export function needsRefresh(sources, now, maxAgeMs) {
	for (const source of Array.isArray(sources) ? sources : []) {
		if (!source || source.unavailable || source.refreshing) continue;
		if (finite(source.nextRefreshAt) && source.nextRefreshAt > now) continue;
		if (!finite(source.observedAt) || now - source.observedAt > maxAgeMs) return true;
		for (const group of Array.isArray(source.groups) ? source.groups : [])
			for (const window of windowsOf(group)) if (finite(window?.resetsAt) && now - window.resetsAt > RESET_GRACE_MS) return true;
	}
	return false;
}
