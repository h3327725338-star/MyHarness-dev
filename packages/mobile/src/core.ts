/**
 * The on-device agent core of the Android app: the same Agent loop and API adapters the desktop product uses,
 * bundled for the phone's WebView (see build.mjs). Nothing here knows about the page; `web/js/backend-local.js`
 * builds sessions, tools and storage on top of it.
 */

import { Type } from "typebox";
import { Agent } from "../../agent/src/agent.ts";
import type { AgentEvent, AgentMessage, AgentTool } from "../../agent/src/types.ts";
import { streamSimple as anthropicMessages } from "../../ai/src/api/anthropic-messages.ts";
import { streamSimple as googleGenerativeAi } from "../../ai/src/api/google-generative-ai.ts";
import { streamSimple as openaiCompletions } from "../../ai/src/api/openai-completions.ts";
import { streamSimple as openaiResponses } from "../../ai/src/api/openai-responses.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../../ai/src/models.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../../ai/src/types.ts";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";

/** The request protocols a phone provider can speak. Each is the desktop adapter of the same name. */
export const APIS = ["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"] as const;
export type MobileApi = (typeof APIS)[number];

const STREAMS: Record<MobileApi, (model: Model<any>, context: Context, options?: SimpleStreamOptions) => any> = {
	"openai-completions": openaiCompletions,
	"anthropic-messages": anthropicMessages,
	"openai-responses": openaiResponses,
	"google-generative-ai": googleGenerativeAi,
};

function failedStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "error", reason: "error", error });
		stream.end(error);
	});
	return stream;
}

/** One request to the model's own protocol; a protocol the phone does not carry ends as a stream error. */
export function streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const run = STREAMS[model.api as MobileApi];
	if (!run) return failedStream(model, `This app has no adapter for the "${model.api}" protocol.`);
	return run(model, context, options);
}

/** One request without tools, answered as a whole (titles, summaries). */
export async function completeSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return streamSimple(model, context, options).result();
}

export { Agent, clampThinkingLevel, getSupportedThinkingLevels, Type };
export type { AgentEvent, AgentMessage, AgentTool, AssistantMessage, Context, Model, SimpleStreamOptions };
