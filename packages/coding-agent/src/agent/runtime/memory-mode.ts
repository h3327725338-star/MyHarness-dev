import type { AgentMessage } from "@myharness/agent-core";
import { loadSystemPrompt } from "../../system-prompts/loader/index.ts";

export const MANUAL_MEMORY_POLICY = loadSystemPrompt("session/manual-memory.md");

export const MEMORY_TOOLS: ReadonlySet<string> = new Set([
	"memory_search",
	"memory_get",
	"memory_write",
	"memory_delete",
	"memory_claim",
]);

export function isExplicitMemoryRequest(text: string): boolean {
	const request = text.replace(/```[\s\S]*?```|^\s*>.*$/gm, "").trim();
	const chinese = request.replace(/^(?:(?:请|麻烦|先|帮我|你可以)\s*)+/, "");
	return (
		/^(?:记住|记一下|记下来|忘掉|把它忘了)/.test(chinese) ||
		/^(?:保存|添加|更正|修改|更新|删除|看(?:看)?|查(?:看|找)?|搜索|读取|导入)(?:一下|这条|那条|我的|本机|手动|长期|关闭模式的|你的|\s)*记忆(?!\s*(?:功能|模式|文档|系统|设置|开关|模块|泄漏))/.test(
			chinese,
		) ||
		/^(?:把|将)[^。！？\n]*(?:记住|记一下|记下来|写进记忆|存到记忆|记到记忆|从记忆中删除|忘掉)/.test(chinese) ||
		/^(?:(?:please|can you|could you)\s+)*(?:(?:remember|forget)\b(?!\s+to\b)|note (?:this|that|it) down\b|(?:save|add|edit|update|correct|delete|list|read|import|search)\b[^.!?\n]*\bmemor(?:y|ies)\b(?!\s*(?:feature|mode|docs?\b|documentation|system|settings?|leak)))/i.test(
			request,
		)
	);
}

export function projectMemoryMessages(messages: AgentMessage[], enabled: boolean): AgentMessage[] {
	return messages.flatMap((message) => {
		if (!enabled && message.role === "custom" && message.customType === "auto-memory-recall") return [];
		if (
			message.role === "toolResult" &&
			MEMORY_TOOLS.has(message.toolName) &&
			(message.details?.manualOnly === true) === enabled
		) {
			return [
				{
					...message,
					content: [{ type: "text" as const, text: "[Memory result from the other mode is hidden.]" }],
					details: undefined,
				},
			];
		}
		return [message];
	});
}
