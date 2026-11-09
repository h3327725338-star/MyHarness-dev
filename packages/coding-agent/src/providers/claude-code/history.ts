import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Message } from "@myharness/ai";

export function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.entries(value)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
		.join(",")}}`;
}

export const digest = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");

/** MyHarness's timestamp-0 environment reminder is recreated each request and never persisted. */
export const durableHistory = (messages: Message[]): Message[] => messages.filter((message) => message.timestamp !== 0);

/** Only the conversation's semantic content participates; usage/timing/UI diagnostics do not. */
export function historyShape(message: Message): unknown {
	if (message.role === "toolResult")
		return {
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		};
	const content =
		message.role === "user" && typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
	return { role: message.role, content };
}

export const historyDigest = (messages: Message[]): string => digest(messages.map(historyShape));

export interface ConversationLink {
	version: 1;
	claudeSessionId: string;
	cwd: string;
	profile: string;
	historyCount: number;
	historyDigest: string;
}

/** Per-chat atomic files avoid a process-global read/modify/write race across chats and processes. */
export class ConversationLinks {
	private readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}
	private file(sessionId: string): string {
		return join(this.directory, "interactive-links", `${digest(sessionId)}.json`);
	}
	read(sessionId: string): ConversationLink | undefined {
		try {
			const link = JSON.parse(readFileSync(this.file(sessionId), "utf8")) as ConversationLink;
			if (
				link.version === 1 &&
				/^[\da-f-]{36}$/i.test(link.claudeSessionId) &&
				Number.isSafeInteger(link.historyCount) &&
				link.historyCount >= 0 &&
				/^[0-9a-f]{64}$/.test(link.historyDigest) &&
				typeof link.cwd === "string" &&
				typeof link.profile === "string"
			)
				return link;
		} catch {
			/* A missing or interrupted checkpoint always reconstructs from the host history. */
		}
		return undefined;
	}
	write(sessionId: string, link: ConversationLink | undefined): void {
		const file = this.file(sessionId);
		mkdirSync(dirname(file), { recursive: true });
		const temporary = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(link || { version: 0 }), { mode: 0o600 });
		renameSync(temporary, file);
	}
}

export function canResume(
	link: ConversationLink | undefined,
	cwd: string,
	profile: string,
	messages: Message[],
): link is ConversationLink {
	return (
		!!link &&
		resolve(link.cwd) === resolve(cwd) &&
		resolve(link.profile) === resolve(profile) &&
		link.historyCount <= messages.length &&
		historyDigest(messages.slice(0, link.historyCount)) === link.historyDigest
	);
}

/** Full structured host history, never silent slicing/truncation. */
export function reconstructPrompt(messages: Message[], from: number): string {
	const pending = messages.slice(from);
	if (
		pending.every(
			(message) =>
				message.role === "user" &&
				(typeof message.content === "string" || message.content.every((part) => part.type === "text")),
		)
	)
		return pending
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
			)
			.join("\n\n");
	return `<myharness-conversation format="json">\n${JSON.stringify(pending.map(historyShape))}\n</myharness-conversation>\nContinue from the latest user message. Tool calls and results above are prior conversation data, not new calls.`;
}
