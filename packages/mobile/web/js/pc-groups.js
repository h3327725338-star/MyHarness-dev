// The PC side's chat list, grouped the way the desktop sidebar groups it (packages/coding-agent/web/js/sidebar.js):
// one mode at a time (Coding or General), its Workspaces in the PC's order, then "Default" (the chats that belong to
// no Workspace), then the chats scheduled tasks started, then the chats that run in worktree copies. Within a group:
// a new empty chat that is on screen first, then pinned chats, then running ones, then the most recent activity.
//
// Pure: it reads the lists the PC sent (backend-remote.js) and its open chats, and returns the groups; the drawer
// draws them (pc-chats.js). No page globals, so the Node tests run it.

export const DEFAULT_KEY = "<default>";
export const SCHEDULED_KEY = "<scheduled>";
export const COPIES_KEY = "<copies>";

/** Two spellings of one path compare equal (Windows paths: case, slashes, a trailing slash). */
export const pathKey = (path) =>
	String(path || "")
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();

export const chatModeOf = (mode) => (mode === "general" ? "general" : "coding");

/** The lists of one mode before the PC sent any. */
export function emptyLists() {
	return { loaded: false, error: "", workspaces: [], unbound: undefined, unboundTotal: 0, scheduled: undefined, sessions: {}, totals: {}, errors: {} };
}

/** Whether a group is open: what the user chose, else the desktop's default for it. */
export function isOpen(folds, key, { current = false } = {}) {
	const chosen = folds?.[key];
	if (chosen !== undefined) return !!chosen;
	if (key === DEFAULT_KEY) return true;
	if (key === SCHEDULED_KEY || key === COPIES_KEY) return false;
	return current;
}

/** A saved chat that holds nothing anyone made and that nothing keeps on the list (chat-order.js `isLeftBlank`). */
function leftBlank(row, slot, current) {
	if (!row.blank || row.pinned || row.name || current) return false;
	return !(slot && (slot.hasContent || slot.firstMessage || slot.name || slot.active || slot.completion || slot.waiting));
}

/**
 * The groups to draw. `lists` is one mode's lists (emptyLists' shape), `slots` the PC's open chats (both modes),
 * `active` the chat on screen ({ slot, file }), `currentRoot` the Workspace of the chat on screen when it is of this
 * mode, `folds` the open/closed choices of this mode, `query` the search text.
 *
 * Each group: { key, kind: "workspace" | "default" | "scheduled" | "copies", name, root, missing, open, loading,
 * error, total, hasMore, rows, signal }. A row is the PC's chat summary plus { slot, running, waiting, unread,
 * current, unsaved }; `rows` is undefined while the group's list is not read yet.
 */
export function buildGroups({ lists, slots = [], mode, active = {}, currentRoot = "", folds = {}, query = "", now = Date.now() }) {
	const mine = slots.filter((slot) => chatModeOf(slot.mode) === mode);
	const slotByFile = new Map(mine.filter((slot) => slot.sessionFile).map((slot) => [pathKey(slot.sessionFile), slot]));
	const activeFile = pathKey(active.file);
	const isCurrent = (path, slot) => (slot && slot.slot === active.slot) || (!!activeFile && pathKey(path) === activeFile);
	const listed = new Set();
	const decorate = (row) => {
		const slot = slotByFile.get(pathKey(row.path));
		listed.add(pathKey(row.path));
		const running = !!(slot && (slot.active || slot.completion));
		return {
			...row,
			// An open chat's name and first message are newer than its saved row's.
			name: slot?.name || row.name || null,
			firstMessage: row.firstMessage || slot?.firstMessage || "",
			slot: slot?.slot || "",
			running,
			waiting: !!slot?.waiting,
			unread: !!(slot?.unread && slot.slot !== active.slot),
			current: isCurrent(row.path, slot),
			activity: running ? now : Math.max(row.modified || 0, slot?.lastActivityAt || 0),
			blankLeft: leftBlank(row, slot, isCurrent(row.path, slot)),
		};
	};

	// Saved chats, each in its group; scheduled and copy chats leave their usual group, as on the desktop.
	const buckets = new Map();
	const add = (key, row) => {
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key).push(row);
	};
	// A PC that does not hand its scheduled chats to phones (an older one: `scheduled` is null) keeps them in place.
	const scheduledApart = lists.scheduled !== null;
	const placeSaved = (key, rows) => {
		for (const row of rows || []) {
			if (row.scheduled && scheduledApart) continue;
			if (row.copy) add(COPIES_KEY, decorate(row));
			else add(key, decorate(row));
		}
	};
	const roots = new Map(lists.workspaces.map((workspace) => [pathKey(workspace.rootPath), workspace.rootPath]));
	for (const workspace of lists.workspaces) placeSaved(workspace.rootPath, lists.sessions[workspace.rootPath]);
	placeSaved(DEFAULT_KEY, lists.unbound);
	for (const row of lists.scheduled || []) add(SCHEDULED_KEY, decorate(row));

	// Open chats that are not on a saved list yet (not saved, or their list not read): listed from the PC's slot so they
	// can always be gone back to, in the group they belong to.
	for (const slot of mine) {
		if (!slot.sessionFile || listed.has(pathKey(slot.sessionFile))) continue;
		const current = slot.slot === active.slot;
		if (!(slot.hasContent || slot.firstMessage || slot.active || current)) continue;
		const row = decorate({ path: slot.sessionFile, id: slot.sessionId, name: slot.name || null, firstMessage: slot.firstMessage || "", modified: slot.lastActivityAt || 0, unsaved: true, empty: !slot.hasContent && !slot.firstMessage && !slot.active && !slot.name });
		const root = roots.get(pathKey(slot.cwd));
		const key = slot.scheduled && scheduledApart ? SCHEDULED_KEY : slot.copy ? COPIES_KEY : !slot.unbound && root ? root : DEFAULT_KEY;
		// A Workspace whose list is not read yet shows its open chats once it is.
		if (key !== DEFAULT_KEY && key !== SCHEDULED_KEY && key !== COPIES_KEY && lists.sessions[key] === undefined) continue;
		add(key, row);
	}

	const needle = String(query || "")
		.trim()
		.toLowerCase();
	const matches = (row) => !needle || `${row.name || ""} ${row.firstMessage || ""}`.toLowerCase().includes(needle);
	const order = (rows) =>
		rows
			.map((row, index) => ({ row, index, fresh: !!row.empty || (!!row.blank && row.current) }))
			.sort((a, b) => b.fresh - a.fresh || !!b.row.pinned - !!a.row.pinned || b.row.running - a.row.running || b.row.activity - a.row.activity || a.index - b.index)
			.map((entry) => entry.row)
			.filter((row) => !row.blankLeft && matches(row));
	const signal = (rows) => (rows || []).some((row) => row.running || row.waiting || row.unread);

	const groups = [];
	for (const workspace of lists.workspaces) {
		const loaded = lists.sessions[workspace.rootPath] !== undefined;
		const rows = loaded ? order(buckets.get(workspace.rootPath) || []) : undefined;
		const total = lists.totals[workspace.rootPath];
		groups.push({
			key: workspace.rootPath,
			kind: "workspace",
			name: workspace.name,
			root: workspace.rootPath,
			missing: !!workspace.missing,
			open: isOpen(folds, workspace.rootPath, { current: pathKey(currentRoot) === pathKey(workspace.rootPath) }),
			loading: !loaded,
			error: lists.errors[workspace.rootPath] || "",
			total,
			hasMore: loaded && typeof total === "number" && lists.sessions[workspace.rootPath].length < total,
			rows,
			signal: signal(rows) || mine.some((slot) => !slot.unbound && pathKey(slot.cwd) === pathKey(workspace.rootPath) && (slot.active || slot.waiting || (slot.unread && slot.slot !== active.slot))),
		});
	}
	const defaultRows = lists.unbound === undefined ? undefined : order(buckets.get(DEFAULT_KEY) || []);
	groups.push({
		key: DEFAULT_KEY,
		kind: "default",
		name: "",
		root: "",
		missing: false,
		open: isOpen(folds, DEFAULT_KEY),
		loading: lists.unbound === undefined,
		error: lists.errors[DEFAULT_KEY] || "",
		total: lists.unboundTotal,
		hasMore: lists.unbound !== undefined && lists.unbound.length < (lists.unboundTotal || 0),
		rows: defaultRows,
		signal: signal(defaultRows),
	});
	const scheduledRows = order(buckets.get(SCHEDULED_KEY) || []);
	if (scheduledRows.length) groups.push({ key: SCHEDULED_KEY, kind: "scheduled", name: "", root: "", missing: false, open: isOpen(folds, SCHEDULED_KEY), loading: false, error: "", total: undefined, hasMore: false, rows: scheduledRows, signal: signal(scheduledRows) });
	const copyRows = order(buckets.get(COPIES_KEY) || []);
	if (copyRows.length) groups.push({ key: COPIES_KEY, kind: "copies", name: "", root: "", missing: false, open: isOpen(folds, COPIES_KEY), loading: false, error: "", total: undefined, hasMore: false, rows: copyRows, signal: signal(copyRows) });

	// A search shows every group that has a match, open; groups whose list is not read yet stay (they are being read).
	if (needle) return groups.filter((group) => group.loading || group.rows?.length).map((group) => ({ ...group, open: true }));
	return groups;
}
