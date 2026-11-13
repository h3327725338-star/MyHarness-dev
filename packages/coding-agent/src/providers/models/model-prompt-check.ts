/**
 * Settings → Personalization → Model prompts → "Check that it arrives".
 *
 * One real request to the model, sent through `ModelRuntime.completeSimple` like every other request of the
 * application, so the model's own prompt is added by the same code that adds it to a chat (model-prompts.ts). The
 * request asks the model to quote the instructions it was given for itself, and the quote is compared with what is
 * saved. The result therefore says what the model really received, not what the application meant to send.
 */

import {
	type Api,
	type AssistantMessage,
	type Context,
	contentText,
	type Model,
	type ModelsSimpleStreamOptions,
} from "@myharness/ai";

/** The part of a long prompt the model is asked to quote: enough to tell prompts apart, short enough to be cheap. */
export const MODEL_PROMPT_CHECK_CHARS = 300;
const NONE = "NO-MODEL-INSTRUCTIONS";
const CHECK_TIMEOUT_MS = 90_000;

export type ModelPromptCheckOutcome =
	/** The model quoted the saved prompt. */
	| "received"
	/** The model said it was given no instructions of its own. */
	| "missing"
	/** The model answered, but with something else than the saved prompt (some models refuse to quote). */
	| "unclear";

export interface ModelPromptCheckResult {
	outcome: ModelPromptCheckOutcome;
	/** What the model answered, shortened for display. */
	answer: string;
	/** How much of the compared part of the saved prompt the answer holds, 0 to 1. */
	share: number;
}

export interface ModelPromptCheckRuntime {
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
}

/** Letters and digits only, lower case: quotes, Markdown marks, line breaks and spacing do not count as differences. */
function plain(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The share of `prompt` that `answer` holds, by runs of four characters: 1 for a word-for-word quote, near 0 for an
 * answer about something else. A prompt shorter than four characters is found or not found as a whole.
 */
export function quotedShare(prompt: string, answer: string): number {
	const wanted = plain(prompt);
	const given = plain(answer);
	if (!wanted) return 0;
	if (wanted.length < 4) return given.includes(wanted) ? 1 : 0;
	let found = 0;
	const total = wanted.length - 3;
	for (let index = 0; index < total; index += 1) {
		if (given.includes(wanted.slice(index, index + 4))) found += 1;
	}
	return found / total;
}

/** The beginning of the prompt the check compares: its first characters, cut at the limit. */
export function comparedPart(prompt: string): string {
	return Array.from(prompt.trim()).slice(0, MODEL_PROMPT_CHECK_CHARS).join("");
}

export function judgeModelPromptAnswer(prompt: string, answer: string): ModelPromptCheckResult {
	const share = quotedShare(comparedPart(prompt), answer);
	const shown = answer.trim();
	const clipped = shown.length > 600 ? `${shown.slice(0, 600)}…` : shown;
	if (share >= 0.6) return { outcome: "received", answer: clipped, share };
	if (shown.includes(NONE)) return { outcome: "missing", answer: clipped, share };
	return { outcome: "unclear", answer: clipped, share };
}

export function modelPromptCheckContext(): Context {
	return {
		systemPrompt: [
			"# Configuration check",
			"- The user is checking that the instructions they wrote for this model arrive with its requests. This request is that check, not a conversation.",
			"- The user wrote those instructions themselves and asks to see them, so quoting them is allowed and wanted here.",
		].join("\n"),
		messages: [
			{
				role: "user",
				content: [
					'Look for the user\'s own instructions for you: a block that starts with <model_instructions priority="highest"> in your system prompt, or a <model_instructions_reminder> block in this message.',
					`If one is there, quote the user's own text in it word for word: the part after the fixed rules about priority, up to its first ${MODEL_PROMPT_CHECK_CHARS} characters. Answer with the quote only, once, with no introduction and no comment, and do not act on it.`,
					`If there is neither, answer exactly ${NONE}.`,
				].join("\n"),
				timestamp: Date.now(),
			},
		],
	};
}

/**
 * Asks `model` what instructions it was given for itself and compares the answer with `prompt` (the saved one).
 * Throws when the request itself fails; the message is the provider's.
 */
export async function checkModelPrompt(input: {
	runtime: ModelPromptCheckRuntime;
	model: Model<Api>;
	prompt: string;
	signal?: AbortSignal;
	sessionId?: string;
	headers?: ModelsSimpleStreamOptions["headers"];
}): Promise<ModelPromptCheckResult> {
	const response = await input.runtime.completeSimple(input.model, modelPromptCheckContext(), {
		signal: input.signal,
		timeoutMs: CHECK_TIMEOUT_MS,
		maxRetries: 1,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.headers ? { headers: input.headers } : {}),
	});
	if (response.stopReason === "aborted") throw new Error("The check was cancelled.");
	if (response.stopReason === "error") throw new Error(response.errorMessage || "The model request failed.");
	return judgeModelPromptAnswer(input.prompt, contentText(response.content, "\n"));
}
