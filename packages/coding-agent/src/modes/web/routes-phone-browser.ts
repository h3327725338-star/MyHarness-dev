/**
 * The PC's built-in browser, as a paired phone uses it: the phone shows a picture of a tab and sends back where a
 * finger tapped, how far it scrolled and what was typed. The pages run here, with this browser's sign-ins; nothing of
 * them is copied to the phone but the picture.
 *
 * One route, a short list of actions. Each becomes a command of the desktop host's browser (the same commands the
 * workspace tool uses); anything else is refused. Without the desktop app there is no browser, and the route says so.
 */
import type { DesktopWorkspaceChannel } from "../../tools/workspace.ts";
import { desktopWorkspaceChannel } from "../../tools/workspace.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

interface HostTab {
	tabId?: string;
	url?: string;
	title?: string;
	loading?: boolean;
	error?: string;
	canGoBack?: boolean;
	canGoForward?: boolean;
	active?: boolean;
}

export interface PhoneBrowserTab {
	id: string;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	/** The tab the PC's own window shows now. */
	active: boolean;
}

const QUICK_MS = 15_000;
const SLOW_MS = 45_000;
const KEYS = new Set([
	"Enter",
	"Backspace",
	"Tab",
	"Escape",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	"Delete",
	"Control+A",
]);

const isWeb = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//iu.test(url);
const number = (value: unknown, name: string): number => {
	const result = Number(value);
	if (!Number.isFinite(result)) throw new HttpError(400, `${name} must be a number.`);
	return result;
};

function publicTab(tab: HostTab): PhoneBrowserTab {
	return {
		id: String(tab.tabId || ""),
		url: String(tab.url || ""),
		title: String(tab.title || ""),
		loading: tab.loading === true,
		canGoBack: tab.canGoBack === true,
		canGoForward: tab.canGoForward === true,
		active: tab.active === true,
	};
}

/** Run one phone action against the host's browser. Exported for tests, which pass a channel of their own. */
export async function phoneBrowserAction(
	channel: DesktopWorkspaceChannel,
	input: Record<string, unknown>,
): Promise<unknown> {
	const action = String(input.action || "");
	const browser = (command: Record<string, unknown>, timeoutMs = QUICK_MS) => channel.request(command, timeoutMs);
	const tabs = async () =>
		((await browser({ action: "list" })) as HostTab[]).filter((tab) => tab.tabId && isWeb(tab.url)).map(publicTab);
	if (action === "tabs") return { tabs: await tabs() };
	if (action === "open") {
		if (!isWeb(input.url)) throw new HttpError(400, "open needs an http(s) address.");
		const url = new URL(input.url).href;
		// The page of the desktop app owns the tabs (their ids, the tab strip): it is asked to add one in the background,
		// the way the workspace tool does, and the host's view is made right away so that its picture can be taken.
		const opened = (await channel.request(
			{ channel: "workspace", action: "open", tab: { type: "browser", url, muted: true }, background: true },
			QUICK_MS,
		)) as {
			tabs?: Array<{ id?: string; type?: string; url?: string }>;
		};
		const tab = (opened?.tabs || []).filter((entry) => entry.type === "browser" && entry.url === url).at(-1);
		if (!tab?.id) throw new HttpError(502, "The PC did not open the tab.");
		const state = (await browser({ action: "ensure", tabId: tab.id, url, muted: true }, SLOW_MS)) as HostTab;
		return { tab: publicTab({ ...state, tabId: tab.id }) };
	}
	const tabId = String(input.tabId || "");
	if (!tabId) throw new HttpError(400, "tabId is required.");
	switch (action) {
		case "shot": {
			const [shot, state] = await Promise.all([
				// A JPEG: a fraction of the PNG's size, and the phone asks for a picture about once a second.
				browser({ action: "snapshot", tabId, format: "jpeg", quality: 70 }, SLOW_MS),
				browser({ action: "state", tabId }),
			]);
			const picture = shot as { snapshot?: string; width?: number; height?: number };
			return {
				image: picture.snapshot || "",
				width: picture.width || 0,
				height: picture.height || 0,
				tab: publicTab(state as HostTab),
			};
		}
		case "tap":
			await browser(
				{
					action: "mouse",
					tabId,
					kind: input.long === true ? "right_click" : "click",
					x: number(input.x, "x"),
					y: number(input.y, "y"),
				},
				SLOW_MS,
			);
			return { ok: true };
		case "wheel":
			await browser(
				{
					action: "scroll",
					tabId,
					deltaX: number(input.deltaX ?? 0, "deltaX"),
					deltaY: number(input.deltaY ?? 0, "deltaY"),
					atX: number(input.x, "x"),
					atY: number(input.y, "y"),
				},
				SLOW_MS,
			);
			return { ok: true };
		case "text": {
			if (typeof input.text !== "string" || input.text.length > 20_000)
				throw new HttpError(400, "text must be a string of at most 20000 characters.");
			if (input.text) await browser({ action: "insertText", tabId, text: input.text }, SLOW_MS);
			if (input.enter === true) await browser({ action: "keys", tabId, keys: "Enter" }, SLOW_MS);
			return { ok: true };
		}
		case "key": {
			const key = String(input.key || "");
			if (!KEYS.has(key)) throw new HttpError(400, "That key is not offered to a phone.");
			await browser({ action: "keys", tabId, keys: key }, SLOW_MS);
			return { ok: true };
		}
		case "navigate": {
			if (!isWeb(input.url)) throw new HttpError(400, "navigate needs an http(s) address.");
			await browser({ action: "navigate", tabId, url: new URL(input.url).href }, SLOW_MS);
			return { ok: true };
		}
		case "back":
		case "forward":
		case "reload":
			await browser({ action, tabId });
			return { ok: true };
		default:
			throw new HttpError(400, "Unknown browser action.");
	}
}

export function registerPhoneBrowserRoutes(
	server: WebHttpServer,
	channel: () => DesktopWorkspaceChannel | undefined = desktopWorkspaceChannel,
): void {
	server.route("POST", "/api/phone-browser", async ({ body }) => {
		const link = channel();
		if (!link)
			throw new HttpError(409, "This PC runs MyHarness without the desktop app, so it has no built-in browser.");
		if (!body || typeof body !== "object") throw new HttpError(400, "Expected an action.");
		try {
			return await phoneBrowserAction(link, body as Record<string, unknown>);
		} catch (error) {
			if (error instanceof HttpError) throw error;
			// The host's own words (a closed tab, a page that drew nothing): the phone shows them.
			throw new HttpError(502, error instanceof Error ? error.message : String(error));
		}
	});
}
