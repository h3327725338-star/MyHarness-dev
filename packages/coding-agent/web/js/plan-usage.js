// Plan limits in the composer bar: what is left of the agy and Claude plans (the five-hour and the weekly window) as a small
// two-bar glyph with the numbers beside it, and a popover with every source, group and window. The numbers come from the
// server (store.js planUsage); this file only draws them and asks for a refresh at the right moments. The decisions
// (which window to show, what state it is in, when a read is due) are in plan-usage-model.js.
import { html, useEffect, useRef, useState, Icon, Popover, Spinner } from "./ui.js";
import { state, useStore } from "./store.js";
import { actions } from "./actions.js";
import { getLang, t } from "./i18n.js";
import { focusSource, focusWindows, formatCountdown, level, minutesSince, needsRefresh, percentOf, resetClock, windowState, worstLevel, worthShowing, WINDOW_KINDS } from "./plan-usage-model.js";

const MINUTE = 60_000;

const kindName = (kind) => (kind === "five_hour" ? t("5-hour") : t("Weekly"));

// One timer and one visibility listener for the whole page, however many composers are mounted, and none of it runs while
// the page is hidden: the browser, not the server, decides when a read is worth asking for.
let watchers = 0;
let timer = null;
function askIfDue() {
	if (document.visibilityState === "visible" && needsRefresh(state.planUsage.sources, Date.now(), 10 * MINUTE)) void actions.refreshPlanUsage({ maxAgeMs: 10 * MINUTE });
}
function watchPlanUsage() {
	if (watchers++ === 0) {
		void actions.refreshPlanUsage({ maxAgeMs: 5 * MINUTE });
		timer = setInterval(askIfDue, MINUTE);
		document.addEventListener("visibilitychange", askIfDue);
	}
	return () => {
		if (--watchers > 0) return;
		clearInterval(timer);
		timer = null;
		document.removeEventListener("visibilitychange", askIfDue);
	};
}

/** Re-render every `ms` (and when the page comes back to the front) so countdowns and "Updated n min ago" stay right. */
function useTicker(ms) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const bump = () => document.visibilityState === "visible" && setTick((n) => n + 1);
		const interval = setInterval(bump, ms);
		document.addEventListener("visibilitychange", bump);
		return () => {
			clearInterval(interval);
			document.removeEventListener("visibilitychange", bump);
		};
	}, [ms]);
}

/** "5-hour 93%, resets in 4 h 40 min" for the tooltip, in whichever state the window is. */
function windowSentence(kind, window, now) {
	const name = kindName(kind);
	if (!window) return t("{name}: no current reading", { name });
	const percent = percentOf(window.leftPercent);
	const phase = windowState(window, now);
	if (phase === "counting") return t("{name} {percent}%, resets in {time}", { name, percent, time: formatCountdown(window.resetsAt - now, t) });
	if (phase === "idle") return t("{name} {percent}%, not started yet", { name, percent });
	return t("{name} {percent}%, reset time unknown", { name, percent });
}

/** Why a window's reset is not a countdown, or when it is due. */
function resetLine(window, now) {
	const phase = windowState(window, now);
	if (phase === "counting") return t("Resets in {time} ({clock})", { time: formatCountdown(window.resetsAt - now, t), clock: resetClock(window.resetsAt, now, getLang()) });
	if (phase === "idle") return t("Not started yet: the window starts with the next request");
	if (phase === "expired") return t("Has reset, waiting for new numbers");
	return t("Reset time unknown");
}

function Bar({ percent, stale }) {
	const lv = level(percent);
	return html`<div class="cu-bar"><i class=${`cu-fill ${lv}`} style=${{ width: `${stale ? 0 : (percentOf(percent) ?? 0)}%` }} /></div>`;
}

function SourceSection({ source, now }) {
	const waiting = !!source.nextRefreshAt && source.nextRefreshAt > now;
	const blocked = !!source.refreshing || waiting;
	const age = minutesSince(source.observedAt, now);
	const refreshTitle = waiting && !source.refreshing ? t("Can refresh again in {time}", { time: formatCountdown(source.nextRefreshAt - now, t) }) : t("Refresh the {label} plan limits", { label: source.label });
	return html`<section class="pu-source">
		<div class="pu-head">
			<strong>${source.label}</strong>
			<span class="grow" />
			${age == null ? null : html`<span class="dim pu-age">${age < 1 ? t("Updated just now") : t("Updated {n} min ago", { n: age })}</span>`}
			<button class="icon-btn sm" disabled=${blocked} title=${refreshTitle} aria-label=${refreshTitle} onClick=${() => actions.refreshPlanUsage({ id: source.id, maxAgeMs: 0 })}>${source.refreshing ? html`<${Spinner} size=${13} />` : html`<${Icon} name="refresh" size=${13} />`}</button>
		</div>
		${source.unavailable ? html`<div class="dim pu-note">${source.unavailable}</div>` : null}
		${source.error ? html`<div class="pu-note pu-error">${t("Could not read the plan limits: {error}", { error: source.error })}</div>` : null}
		${source.unavailable ? null : (source.groups || []).map((group, index) => {
			const windows = WINDOW_KINDS.map((kind) => (group.windows || []).find((window) => window.kind === kind)).filter(Boolean);
			if (!windows.length) return null;
			return html`<div class="pu-group" key=${`${group.label}:${index}`}>
				<div class="dim pu-caption">${group.label || t("All models")}</div>
				${windows.map((window) => {
					const stale = windowState(window, now) === "expired";
					const percent = percentOf(window.leftPercent);
					return html`<div class="pu-row" key=${window.kind}>
						<span class="pu-name">${kindName(window.kind)}</span>
						<span class="pu-reset">${resetLine(window, now)}</span>
						<strong class=${`pu-pct ${stale ? "" : level(window.leftPercent)}`}>${stale || percent == null ? "–" : `${percent}%`}</strong>
						<${Bar} percent=${window.leftPercent} stale=${stale} />
					</div>`;
				})}
			</div>`;
		})}
	</section>`;
}

/**
 * The meter in front of the context ring: two bars (five-hour on top, weekly below) and "5h 93% · 7d 74%", with the plan's
 * name in front when the chat's model is of another provider; click for the details.
 */
export function PlanUsageMeter() {
	const anchor = useRef(null);
	const sources = useStore((s) => s.planUsage.sources);
	const model = useStore((s) => s.snap?.model);
	const sessionId = useStore((s) => s.snap?.session?.id);
	const [open, setOpen] = useState(false);
	// The room above the bar, measured while the popover is open and kept while it closes: the fade-out must leave the
	// popover as tall as it was, not cut it to a default height in its first frame.
	const room = useRef(520);
	// Once a minute is enough for the button (an expired window turns to "–"); the open popover shows minutes, so half that.
	useTicker(open ? MINUTE / 2 : MINUTE);
	useEffect(() => watchPlanUsage(), []);
	useEffect(() => {
		setOpen(false);
	}, [sessionId]);
	if (!worthShowing(sources)) return null;

	const now = Date.now();
	const source = focusSource(sources, model, now) ?? sources.find((item) => item.unavailable || item.error);
	const onProvider = !!model && model.provider === source.id;
	const focus = focusWindows(source, onProvider ? model.id : undefined, now);
	const five = focus.five_hour;
	const week = focus.weekly;
	const percentText = (window) => (window ? `${percentOf(window.leftPercent)}%` : "–");
	// Beside a model of the same provider the numbers need no name; anywhere else they say whose plan they are.
	const text = `${onProvider ? "" : `${source.label} `}${t("5h {percent}", { percent: percentText(five) })} · ${t("7d {percent}", { percent: percentText(week) })}`;
	const tone = worstLevel([level(five?.leftPercent), level(week?.leftPercent)]);
	const title = five || week
		? t("{label} plan left: {windows}", { label: source.label, windows: t("{first}; {second}", { first: windowSentence("five_hour", five, now), second: windowSentence("weekly", week, now) }) })
		: source.unavailable || (source.error ? t("Could not read the plan limits: {error}", { error: source.error }) : t("Plan limits"));
	const toggle = () => {
		if (!open && needsRefresh(sources, Date.now(), MINUTE)) void actions.refreshPlanUsage({ maxAgeMs: MINUTE });
		setOpen(!open);
	};
	const bar = (window) => html`<i class="plan-bar"><i class=${`cu-fill ${level(window?.leftPercent)}`} style=${{ width: `${window ? (percentOf(window.leftPercent) ?? 0) : 0}%` }} /></i>`;
	// The plan the button speaks for comes first. The popover is as tall as the room above the bar allows: every source
	// shows without scrolling in a window of usual height, and it never has to open over the composer in a low one.
	const ordered = [source, ...sources.filter((item) => item !== source)];
	if (open && anchor.current) room.current = anchor.current.getBoundingClientRect().top - 16;
	const maxHeight = Math.max(240, Math.min(680, Math.floor(room.current)));
	return html`<span ref=${anchor} class="picker-anchor">
		<button class=${`plan-meter ${tone}`} aria-haspopup="dialog" aria-expanded=${open} title=${title} aria-label=${title} onClick=${toggle}>
			<span class="plan-glyph" aria-hidden="true">${bar(five)}${bar(week)}</span>
			<span class="plan-text">${text}</span>
		</button>
		<${Popover} anchor=${anchor} open=${open} onClose=${() => setOpen(false)} placement="top" align="end" width=${340} maxHeight=${maxHeight}>
			<div class="pu" aria-label=${t("Plan limits")}>
				${ordered.map((item) => html`<${SourceSection} key=${item.id} source=${item} now=${now} />`)}
				<div class="dim pu-foot">${t("Percent left of each limit. Numbers come from the programs' own usage commands.")}</div>
			</div>
		<//>
	</span>`;
}
