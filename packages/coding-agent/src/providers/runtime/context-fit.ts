/**
 * Keeps every request inside the context window the user set for its model.
 *
 * The main chat and sub-agents compact before they reach the window (context/coordinator.ts). Helper requests
 * (the compaction summary on another model, memory, titles, commit messages, ...) are built from whatever the
 * caller has, which may be a conversation sized for a much larger model. `ModelRuntime.stream` / `streamSimple`
 * pass every request through `fitContextToModelWindow`, so a request that would not fit is cut down here instead of
 * being sent whole: long tool outputs and long pasted texts lose their middle first, then the oldest messages go.
 * A request that already fits is returned as the same object.
 */

import {
	type Api,
	type Context,
	estimateContextTokens,
	estimateMessageTokens,
	type ImageContent,
	type Message,
	type Model,
	type TextContent,
} from "@myharness/ai";

/** Tokens the provider keeps free by its own count (clampMaxTokensToContext in @myharness/ai). */
const PROVIDER_SAFETY_TOKENS = 4096;
/** Share of the window left free, the same share the main chat keeps (context-window.ts). */
const FREE_WINDOW_RATIO = 0.05;
/** Room kept for the answer of a request that had to be cut: this share of the window, at least this many tokens. */
const ANSWER_WINDOW_RATIO = 0.15;
const ANSWER_MIN_TOKENS = 8192;
/** A text is never cut below this many UTF-8 bytes while older messages can still be dropped. */
const TEXT_FLOOR_BYTES = 4096;

const encoder = new TextEncoder();
const utf8Length = (text: string): number => encoder.encode(text).length;

export interface ContextFitResult {
	context: Context;
	/** False when the request already fitted and was not touched. */
	changed: boolean;
	/** Estimated tokens before and after, and the most the request may hold. */
	tokensBefore: number;
	tokensAfter: number;
	limit: number;
}

/**
 * The most input tokens a request to this model may hold; 0 when the model has no usable window. It is the main
 * chat's own limit (context-budget.ts), so a chat that compacts in time is never cut here.
 */
export function requestTokenLimit(model: Pick<Model<Api>, "contextWindow" | "managesOwnContext">): number {
	const window = model.contextWindow;
	if (model.managesOwnContext || !Number.isFinite(window) || window <= 0) return 0;
	return Math.max(0, Math.floor(window - Math.ceil(window * FREE_WINDOW_RATIO)));
}

/** What a request over the limit is cut down to: the window less the room its answer needs. */
function cutTarget(model: Pick<Model<Api>, "contextWindow" | "maxTokens">, limit: number): number {
	const window = model.contextWindow;
	const wanted = Math.max(ANSWER_MIN_TOKENS, Math.floor(window * ANSWER_WINDOW_RATIO));
	const answer = model.maxTokens > 0 ? Math.min(model.maxTokens, wanted) : wanted;
	const target = window - PROVIDER_SAFETY_TOKENS - answer;
	return target > 0 ? Math.min(limit, target) : limit;
}

function cutMiddle(text: string, targetBytes: number): string {
	const bytes = utf8Length(text);
	if (bytes <= targetBytes) return text;
	const note = `\n[… about ${Math.ceil((bytes - targetBytes) / 4)} tokens left out to fit this model's context window …]\n`;
	const keepChars = Math.max(0, Math.floor((text.length * Math.max(0, targetBytes - utf8Length(note))) / bytes));
	let head = Math.ceil(keepChars * 0.6);
	let tail = text.length - (keepChars - head);
	// Never split a surrogate pair.
	if (head > 0 && head < text.length && /[\uD800-\uDBFF]/.test(text[head - 1]!)) head--;
	if (tail > 0 && tail < text.length && /[\uDC00-\uDFFF]/.test(text[tail]!)) tail++;
	return `${text.slice(0, head)}${note}${text.slice(tail)}`;
}

type TextSlot = { message: number; block: number | null; bytes: number };

function textSlots(messages: readonly Message[], from: number, to: number): TextSlot[] {
	const slots: TextSlot[] = [];
	for (let index = from; index < to; index++) {
		const message = messages[index]!;
		if (message.role === "assistant") continue;
		if (message.role === "user" && message.compactionCheckpoint) continue;
		const content = message.content as string | Array<TextContent | ImageContent>;
		if (typeof content === "string") {
			slots.push({ message: index, block: null, bytes: utf8Length(content) });
			continue;
		}
		content.forEach((block, blockIndex) => {
			if (block.type === "text") slots.push({ message: index, block: blockIndex, bytes: utf8Length(block.text) });
		});
	}
	return slots;
}

/** The byte cap that, applied to every slot, frees `needBytes`; never below `floor`. */
function capFor(slots: readonly TextSlot[], needBytes: number, floor: number): number {
	const saved = (cap: number) => slots.reduce((sum, slot) => sum + Math.max(0, slot.bytes - cap), 0);
	let low = floor;
	let high = slots.reduce((max, slot) => Math.max(max, slot.bytes), floor);
	if (saved(low) <= needBytes) return low;
	while (high - low > 64) {
		const middle = Math.floor((low + high) / 2);
		if (saved(middle) >= needBytes) low = middle;
		else high = middle;
	}
	return low;
}

function applyCap(messages: Message[], slots: readonly TextSlot[], cap: number): void {
	for (const slot of slots) {
		if (slot.bytes <= cap) continue;
		const message = messages[slot.message]!;
		if (message.role === "assistant") continue;
		const content = message.content as string | Array<TextContent | ImageContent>;
		if (slot.block === null || typeof content === "string") {
			messages[slot.message] = { ...message, content: cutMiddle(content as string, cap) } as Message;
			continue;
		}
		const blocks = content.slice();
		const block = blocks[slot.block] as TextContent;
		blocks[slot.block] = { ...block, text: cutMiddle(block.text, cap) };
		messages[slot.message] = { ...message, content: blocks } as Message;
	}
}

/** Drops the oldest message with the tool calls and tool results that belong to it. */
function removeOldest(messages: Message[]): void {
	const removed = messages.shift();
	if (!removed) return;
	const ids = new Set<string>();
	if (removed.role === "assistant") {
		for (const block of removed.content) if (block.type === "toolCall") ids.add(block.id);
	} else if (removed.role === "toolResult") ids.add(removed.toolCallId);
	if (ids.size === 0) return;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "toolResult" && ids.has(message.toolCallId)) messages.splice(index, 1);
		else if (message.role === "assistant") {
			const content = message.content.filter((block) => block.type !== "toolCall" || !ids.has(block.id));
			if (content.length === message.content.length) continue;
			if (content.length) messages[index] = { ...message, content };
			else messages.splice(index, 1);
		}
	}
}

/** Usage numbers describe the request they came from, not the cut one: without them the estimate is the plain sum. */
function withoutUsageAnchors(messages: readonly Message[]): Message[] {
	return messages.map((message) => {
		if (message.role !== "assistant") return message;
		const usage = message.usage;
		if (!usage) return message;
		return {
			...message,
			usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		};
	});
}

const sumTokens = (messages: readonly Message[]): number =>
	messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

export function fitContextToModelWindow(model: Model<Api>, context: Context): ContextFitResult {
	const limit = requestTokenLimit(model);
	const tokensBefore = limit > 0 ? estimateContextTokens(context).tokens : 0;
	const untouched = { context, changed: false, tokensBefore, tokensAfter: tokensBefore, limit };
	if (limit <= 0 || tokensBefore <= limit || context.messages.length === 0) return untouched;

	const messages = withoutUsageAnchors(context.messages);
	const prefix = estimateContextTokens({ ...context, messages: [] }).tokens;
	const room = cutTarget(model, limit) - prefix;
	let total = sumTokens(messages);
	// The usage anchor counted more than the plain sum does (a request built from part of a larger conversation).
	// The plain sum fits: only the stale anchors go, so the provider's own count agrees.
	if (prefix + total <= limit) {
		return { ...untouched, context: { ...context, messages }, changed: true, tokensAfter: prefix + total };
	}
	if (room <= 0) return untouched;

	// 1. Long texts before the newest message lose their middle, the longest first.
	const last = messages.length - 1;
	const older = textSlots(messages, 0, last);
	if (older.length) {
		applyCap(messages, older, capFor(older, (total - room) * 4 + 256, TEXT_FLOOR_BYTES));
		total = sumTokens(messages);
	}
	// 2. Then the oldest messages go, down to the newest one.
	while (total > room && messages.length > 1) {
		removeOldest(messages);
		total = sumTokens(messages);
	}
	while (messages.length > 1 && messages[0]!.role !== "user") removeOldest(messages);
	total = sumTokens(messages);
	// 3. The newest message alone is still too long: its texts are cut as far as needed.
	if (total > room) {
		const slots = textSlots(messages, 0, messages.length);
		if (slots.length) {
			applyCap(messages, slots, capFor(slots, (total - room) * 4 + 256, 256));
			total = sumTokens(messages);
		}
	}
	return {
		context: { ...context, messages },
		changed: true,
		tokensBefore,
		tokensAfter: prefix + total,
		limit,
	};
}
