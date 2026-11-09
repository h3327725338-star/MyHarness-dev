// Background panel: what keeps running for the chat on screen after the agent's call returned. The commands the bash
// and pwsh tools started with run_in_background (the server's job store, with their logs) and the sub-agents that run
// in the background (the rows of the bar above the input). Every status is the server's; nothing here guesses one.
import { html, useEffect, useState, Collapse, CopyButton, Fold, Icon, Spinner } from "./ui.js";
import { api, post, toast, useStore } from "./store.js";
import { Section } from "./panel-context.js";
import { Output } from "./panel-terminal.js";
import { StopButton, SubAgentRows, stopSubAgents, TaskStatusIcon, useNow } from "./sub-agents.js";
import { getLang, t, N_ } from "./i18n.js";
import { fmtBytes, fmtDateTime, fmtDuration, stripAnsi } from "./util.js";

/** The end of a command's output the panel reads first, and the most a "show earlier output" reads (the server's cap). */
const TAIL_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 1024 * 1024;
/** How often an open, running command's output is read again. */
const OUTPUT_POLL_MS = 1000;

const JOB_STATUS = {
	running: N_("Running"),
	completed: N_("Done"),
	failed: N_("Failed"),
	killed: N_("Stopped"),
	timed_out: N_("Timed out"),
};

const EMPTY_JOBS = [];
const EMPTY_ITEMS = [];

const isRunningJob = (job) => job.status === "running";
const backgroundItems = (state) => (state?.items || EMPTY_ITEMS).filter((item) => item.background);
const runningTaskCount = (items) => items.reduce((sum, item) => sum + item.tasks.filter((task) => task.status === "running").length, 0);

/** How many background commands and background sub-agents of the chat on screen run now (the header button's badge). */
export function useBackgroundRunning() {
	const jobs = useStore((s) => (s.backgroundJobs || EMPTY_JOBS).filter(isRunningJob).length);
	const agents = useStore((s) => runningTaskCount(backgroundItems(s.subAgentState)));
	const connected = useStore((s) => s.connected);
	return connected === false ? 0 : jobs + agents;
}

/** Running commands first (in the order they started), then the ended ones, the latest to end first. */
function orderJobs(jobs) {
	const running = jobs.filter(isRunningJob).sort((a, b) => a.startedAt - b.startedAt);
	const ended = jobs.filter((job) => !isRunningJob(job)).sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
	return [...running, ...ended];
}

/** A start time: the clock time today, the day and time before. */
function startedText(ts) {
	if (!ts) return "";
	const date = new Date(ts);
	if (date.toDateString() !== new Date().toDateString()) return fmtDateTime(ts);
	return date.toLocaleTimeString(getLang(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function JobStatusIcon({ job, unknown }) {
	if (job.status === "running") return html`<${TaskStatusIcon} status="running" unknown=${unknown} />`;
	if (job.status === "completed") return html`<${TaskStatusIcon} status="completed" />`;
	if (job.status === "killed") return html`<${TaskStatusIcon} status="cancelled" />`;
	return html`<${TaskStatusIcon} status="failed" />`;
}

/** The status words of a row: how it ended (with the exit code when it says more than "Done"). */
function jobStatusText(job, unknown) {
	if (job.status === "running") return unknown ? t("Status unknown") : t("Running");
	if (job.status === "failed" && job.exitCode !== undefined && job.exitCode !== null) return t("exit {exitCode}", { exitCode: job.exitCode });
	return t(JOB_STATUS[job.status] || job.status);
}

/**
 * The end of one command's output while its row is open: read once, then every second while the command runs. A
 * reading that did not change keeps the old object, so the output is not drawn again for nothing.
 */
function useJobOutput(job, open, bytes) {
	const [tail, setTail] = useState(undefined);
	const [error, setError] = useState("");
	const running = isRunningJob(job);
	useEffect(() => {
		if (!open) return undefined;
		let stopped = false;
		let busy = false;
		const load = async () => {
			if (busy || stopped || document.visibilityState === "hidden") return;
			busy = true;
			try {
				const data = await api(`/api/background/output?id=${encodeURIComponent(job.id)}&bytes=${bytes}`);
				if (stopped) return;
				setTail((old) => (old && old.text === data.text && old.status === data.status && old.size === data.size && old.skipped === data.skipped ? old : data));
				setError("");
			} catch (failure) {
				if (!stopped) setError(failure.message || String(failure));
			} finally {
				busy = false;
			}
		};
		load();
		const timer = running ? setInterval(load, OUTPUT_POLL_MS) : 0;
		return () => {
			stopped = true;
			if (timer) clearInterval(timer);
		};
	}, [open, job.id, running, bytes]);
	return { tail, error };
}

async function stopJob(id) {
	try {
		await post("/api/background/stop", { id });
	} catch (error) {
		toast(t("Could not stop the background command: {error}", { error: error.message || String(error) }), "error", 10000);
	}
}

/** What an open command row shows: where and how it runs, then the end of its output, kept current while it runs. */
function JobDetail({ job }) {
	const [bytes, setBytes] = useState(TAIL_BYTES);
	const [wrap, setWrap] = useState(true);
	const { tail, error } = useJobOutput(job, true, bytes);
	const running = isRunningJob(job);
	const multiline = job.command.includes("\n");
	const text = tail?.text ?? "";
	const skipped = tail?.skipped ?? 0;
	return html`<div class="bg-detail">
		<div class="bg-facts">
			<span class="badge">${job.tool === "pwsh" ? "PowerShell" : "bash"}</span>
			<span class="mono dim truncate bg-cwd" title=${job.cwd}>${job.cwd}</span>
			<span class="dim">${t("Started {time}", { time: startedText(job.startedAt) })}</span>
			<span class="grow" />
			<button type="button" class=${`icon-btn sm ${wrap ? "active" : ""}`} title=${t("Wrap long lines")} aria-label=${t("Wrap long lines")} aria-pressed=${wrap} onClick=${() => setWrap(!wrap)}><${Icon} name="list" size=${14} /></button>
			<${CopyButton} text=${job.command} label=${t("Copy command")} />
			<${CopyButton} text=${() => stripAnsi(text)} label=${t("Copy output")} />
		</div>
		${multiline ? html`<pre class="bg-command mono">${job.command}</pre>` : null}
		${job.logTruncated || tail?.logTruncated ? html`<div class="notice warn bg-notice"><span>${t("The output grew past the size a background command may write; what came after that was not saved.")}</span></div>` : null}
		${skipped > 0 ? html`<div class="bg-more dim">
			<span>${t("Showing the last {size}; {skipped} before it are left out.", { size: fmtBytes(Math.max(0, (tail?.size ?? 0) - skipped)), skipped: fmtBytes(skipped) })}</span>
			${bytes < TAIL_MAX_BYTES ? html`<button type="button" class="link-btn" onClick=${() => setBytes(TAIL_MAX_BYTES)}>${t("Show earlier output")}</button>` : null}
			${bytes >= TAIL_MAX_BYTES && tail?.logPath ? html`<span>${t("The whole log:")} <code class="bg-log">${tail.logPath}</code></span><${CopyButton} text=${tail.logPath} label=${t("Copy path")} size=${13} />` : null}
		</div>` : null}
		<div class="bg-out">
			${tail === undefined && !error
				? html`<div class="bg-loading dim"><${Spinner} size=${13} />${t("Loading…")}</div>`
				: error && tail === undefined
					? html`<div class="bg-loading c-danger">${error}</div>`
					: html`<${Output} text=${text} wrap=${wrap} follow=${running} />`}
		</div>
	</div>`;
}

/** One background command: status, the command's first line, how it ended and how long it ran, opening to its output. */
function JobRow({ job, now, unknown, open, onToggle }) {
	const running = isRunningJob(job);
	const firstLine = job.command.split("\n")[0];
	const elapsed = Math.max(0, (running ? now : job.endedAt || now) - job.startedAt);
	const rowClick = (event) => {
		if (event.target.closest?.(".sa-icon-btn")) return;
		onToggle();
	};
	return html`<div class=${`sa-task bg-job s-${unknown && running ? "unknown" : job.status}`}>
		<div class="sa-row" onClick=${rowClick}>
			<button type="button" class="sa-toggle" aria-expanded=${open} title=${job.command}>
				<span class="sa-ico"><${JobStatusIcon} job=${job} unknown=${unknown} /></span>
				<span class="sa-name truncate mono bg-cmd">${firstLine}${firstLine !== job.command ? html`<span class="dim"> …</span>` : null}</span>
				<span class=${`sa-activity ${running && !unknown ? "" : "dim"}`}>${jobStatusText(job, unknown)}</span>
				<span class="sa-time">${elapsed >= 1000 ? fmtDuration(elapsed) : ""}</span>
			</button>
			${running && !unknown ? html`<${StopButton} label=${t("Stop this command")} title=${t("Ends this command and everything it started. The agent sees it as stopped.")} onStop=${() => stopJob(job.id)} />` : null}
			<span class="sa-chev" aria-hidden="true"><${Fold} /></span>
		</div>
		<${Collapse} open=${open}><${JobDetail} job=${job} /><//>
	</div>`;
}

export function BackgroundPanel() {
	const jobs = useStore((s) => s.backgroundJobs || EMPTY_JOBS);
	const subAgentState = useStore((s) => s.subAgentState);
	const unknown = useStore((s) => s.connected === false);
	const [openIds, setOpenIds] = useState(() => new Set());
	const ordered = orderJobs(jobs);
	const agents = backgroundItems(subAgentState);
	const runningJobs = jobs.filter(isRunningJob).length;
	const runningAgents = runningTaskCount(agents);
	const now = useNow(!unknown && runningJobs > 0);
	const toggle = (id) =>
		setOpenIds((old) => {
			const next = new Set(old);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const running = runningJobs + runningAgents;
	const summary = unknown ? t("Status unknown (reconnecting…)") : running > 0 ? t("{n} running", { n: running }) : t("Nothing running");
	const runningAgentIds = agents.filter((item) => item.tasks.some((task) => task.status === "running")).map((item) => item.id);
	const stopAgents = !unknown && runningAgentIds.length
		? html`<${StopButton} label=${t("Stop the background sub-agents")} title=${t("Stops only these sub-agents; the main agent is not stopped.")} onStop=${() => stopSubAgents({ ids: runningAgentIds })} />`
		: null;
	return html`<div class="bg-panel">
		<div class="panel-scroll">
			<div class="panel-toolbar">
				<span class="panel-title">${t("Background tasks")}</span>
				<span class=${`bg-summary ${running > 0 && !unknown ? "" : "dim"}`}>${running > 0 && !unknown ? html`<${Spinner} size=${12} />` : null}${summary}</span>
			</div>
			<${Section} title=${t("Commands")} count=${jobs.length || null}>
				${ordered.length
					? html`<div class="sa-list bg-list">${ordered.map((job) => html`<${JobRow} key=${job.id} job=${job} now=${now} unknown=${unknown} open=${openIds.has(job.id)} onToggle=${() => toggle(job.id)} />`)}</div>`
					: html`<div class="dim bg-empty">${t("No background commands. A command the agent starts with run_in_background is listed here with its output, and stays until MyHarness restarts.")}</div>`}
			<//>
			<${Section} title=${t("Sub-agents")} count=${agents.reduce((sum, item) => sum + item.tasks.length, 0) || null} actions=${stopAgents}>
				${agents.length
					? html`<${SubAgentRows} items=${agents} />`
					: html`<div class="dim bg-empty">${t("No sub-agents running in the background. A sub-agent started in the background is listed here while it runs; its result comes back to the chat as a new reply.")}</div>`}
			<//>
		</div>
	</div>`;
}
