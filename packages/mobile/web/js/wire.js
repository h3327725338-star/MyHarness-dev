// The phone agent's messages (AgentMessage, as @myharness/agent-core holds them) in the shape the transcript reads:
// the desktop's wire items (packages/coding-agent/src/modes/web/wire.ts). Only what the phone can produce is covered.
import { t } from "/shared/i18n.js";

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("");
}

export function imagesOf(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((part) => part?.type === "image" && part.data).map((part) => ({ mimeType: part.mimeType, data: part.data }));
}

/** A failed request in words a person can act on; the provider's own text follows when there is one. */
export function explainError(message) {
	const text = String(message || "").trim();
	if (!text) return "";
	if (/\b401\b|invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication/i.test(text)) return `${t("The API key was refused. Check it in Settings → Models.")}\n${text}`;
	if (/\b402\b|insufficient|quota|balance|billing/i.test(text)) return `${t("The provider reports no remaining balance or quota.")}\n${text}`;
	if (/\b429\b|rate.?limit|too many requests/i.test(text)) return `${t("The provider is rate limiting requests. Try again in a moment.")}\n${text}`;
	if (/\b404\b|model.*not.*(found|exist)|no such model/i.test(text)) return `${t("The provider does not know this model, or the address is wrong.")}\n${text}`;
	if (/failed to connect|unable to resolve|timeout|timed out|network|connection (error|refused|reset)|unexpected end of stream/i.test(text)) return `${t("The provider could not be reached. Check the network and the address.")}\n${text}`;
	return text;
}

export function wireAssistant(message, id) {
	return {
		kind: "assistant",
		id,
		ts: message.timestamp,
		blocks: (message.content || []).map((part) => {
			if (part.type === "text") return { type: "text", text: part.text || "" };
			if (part.type === "thinking") return { type: "thinking", text: part.thinking || "", redacted: part.redacted };
			return { type: "toolCall", id: part.id, name: part.name, args: part.arguments };
		}),
		stopReason: message.stopReason,
		error: message.stopReason === "error" ? explainError(message.errorMessage) : undefined,
		provider: message.provider,
		model: message.model,
		usage: message.usage ? { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, reasoning: message.usage.reasoning, totalTokens: message.usage.totalTokens, cost: message.usage.cost?.total || 0 } : undefined,
	};
}

/** One saved entry ({ id, ts, message, meta }) as a wire item, or null for messages the transcript does not show. */
export function wireEntry(entry) {
	const message = entry.message;
	if (!message) return null;
	if (message.role === "user") {
		return {
			kind: "user",
			id: entry.id,
			ts: message.timestamp,
			// What the user typed; the text sent to the model also carries the attached files' contents.
			text: entry.meta?.text ?? textOf(message.content),
			images: imagesOf(message.content),
			attachments: entry.meta?.attachments || [],
			clientMessageId: entry.meta?.clientMessageId,
		};
	}
	if (message.role === "assistant") return { ...wireAssistant(message, entry.id), final: true, endedAt: entry.meta?.endedAt };
	if (message.role === "toolResult") {
		return {
			kind: "toolResult",
			id: entry.id,
			ts: message.timestamp,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			text: textOf(message.content),
			images: imagesOf(message.content),
			isError: !!message.isError,
			details: message.details,
		};
	}
	return null;
}

export function wireEntries(entries) {
	const items = [];
	for (const entry of entries) {
		const item = wireEntry(entry);
		if (item) items.push(item);
	}
	return items;
}
