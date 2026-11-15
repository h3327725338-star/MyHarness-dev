import { describe, expect, it } from "vitest";
import { HttpError } from "../src/modes/web/http-server.ts";
import { phoneBrowserAction } from "../src/modes/web/routes-phone-browser.ts";
import type { DesktopWorkspaceChannel } from "../src/tools/workspace.ts";

/** A host that records the commands it was given and answers the way the desktop app's browser does. */
function host() {
	const sent: Array<Record<string, unknown>> = [];
	const tab = {
		tabId: "browser:https://mail.example.com/",
		url: "https://mail.example.com/",
		title: "Mail",
		loading: false,
		canGoBack: true,
		active: true,
	};
	const channel = {
		async request(command: Record<string, unknown>) {
			sent.push(command);
			if (command.channel === "workspace")
				return { tabs: [{ id: "browser:n1", type: "browser", url: (command.tab as { url: string }).url }] };
			switch (command.action) {
				case "list":
					return [
						tab,
						{ tabId: "file:C:/notes.md", url: "", title: "notes.md" },
						{ tabId: "browser:local", url: "file:///C:/x.html" },
					];
				case "snapshot":
					return { snapshot: "data:image/png;base64,AAAA", width: 900, height: 700 };
				case "state":
					return tab;
				case "ensure":
					return { tabId: command.tabId, url: command.url, title: "", loading: true };
				default:
					return { ok: true };
			}
		},
	} as unknown as DesktopWorkspaceChannel;
	return { channel, sent };
}

describe("the PC's browser as a phone uses it", () => {
	it("lists web tabs only and gives a tab's picture with its state", async () => {
		const { channel } = host();
		expect(await phoneBrowserAction(channel, { action: "tabs" })).toEqual({
			tabs: [
				{
					id: "browser:https://mail.example.com/",
					url: "https://mail.example.com/",
					title: "Mail",
					loading: false,
					canGoBack: true,
					canGoForward: false,
					active: true,
				},
			],
		});
		expect(await phoneBrowserAction(channel, { action: "shot", tabId: "browser:https://mail.example.com/" })).toEqual(
			{
				image: "data:image/png;base64,AAAA",
				width: 900,
				height: 700,
				tab: expect.objectContaining({ title: "Mail", canGoBack: true }),
			},
		);
	});

	it("turns taps, scrolling and typing into the host's commands", async () => {
		const { channel, sent } = host();
		const tabId = "browser:https://mail.example.com/";
		await phoneBrowserAction(channel, { action: "shot", tabId });
		expect(sent.splice(0)).toEqual([
			{ action: "snapshot", tabId, format: "jpeg", quality: 70 },
			{ action: "state", tabId },
		]);
		await phoneBrowserAction(channel, { action: "tap", tabId, x: 120, y: 48 });
		await phoneBrowserAction(channel, { action: "wheel", tabId, x: 200, y: 300, deltaY: 480 });
		await phoneBrowserAction(channel, { action: "text", tabId, text: "你好", enter: true });
		await phoneBrowserAction(channel, { action: "key", tabId, key: "Backspace" });
		await phoneBrowserAction(channel, { action: "back", tabId });
		expect(sent).toEqual([
			{ action: "mouse", tabId, kind: "click", x: 120, y: 48 },
			{ action: "scroll", tabId, deltaX: 0, deltaY: 480, atX: 200, atY: 300 },
			{ action: "insertText", tabId, text: "你好" },
			{ action: "keys", tabId, keys: "Enter" },
			{ action: "keys", tabId, keys: "Backspace" },
			{ action: "back", tabId },
		]);
	});

	it("opens a web address in a background tab of the desktop app", async () => {
		const { channel, sent } = host();
		expect(await phoneBrowserAction(channel, { action: "open", url: "https://web.whatsapp.com" })).toEqual({
			tab: expect.objectContaining({ id: "browser:n1", url: "https://web.whatsapp.com/" }),
		});
		expect(sent[0]).toEqual({
			channel: "workspace",
			action: "open",
			tab: { type: "browser", url: "https://web.whatsapp.com/", muted: true },
			background: true,
		});
		expect(sent[1]).toEqual({ action: "ensure", tabId: "browser:n1", url: "https://web.whatsapp.com/", muted: true });
	});

	it("refuses what a phone is not offered", async () => {
		const { channel, sent } = host();
		const tabId = "browser:https://mail.example.com/";
		for (const input of [
			{ action: "exec", tabId, code: "document.cookie" },
			{ action: "open", url: "file:///C:/Windows/win.ini" },
			{ action: "navigate", tabId, url: "javascript:alert(1)" },
			{ action: "key", tabId, key: "Control+Shift+Delete" },
			{ action: "tap", tabId, x: "left", y: 2 },
			{ action: "shot" },
		]) {
			await expect(phoneBrowserAction(channel, input)).rejects.toBeInstanceOf(HttpError);
		}
		expect(sent).toEqual([]);
	});
});
