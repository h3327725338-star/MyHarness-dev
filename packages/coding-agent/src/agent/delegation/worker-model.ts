/**
 * What a sub-agent's worker needs to run on the configured sub-agent model, decided in the dispatching session.
 *
 * The worker is a process of its own. It reads the saved providers and models itself, but it loads no extensions: a
 * model that an extension registered (the Claude Code shell, a user's own provider extension) does not exist there
 * until the worker is handed that extension's file. And MyHarness confines a sub-agent by checking every tool call it
 * runs (the read-only rule, the sandbox folder), which it cannot do for a program that runs tools by itself.
 */
import type { Model } from "@myharness/ai";
import type { Extension } from "../../extensions/runtime/types.ts";

export interface WorkerModelSupport {
	/** The extension file the worker loads to have this model, when the model comes from one. */
	providerExtensionPath?: string;
	/** Why no sub-agent can run on this model; the dispatch is refused with this text before anything starts. */
	unavailableReason?: string;
}

const CHANGE_MODEL_HINT = "请在设置的“子智能体”里换一个模型。";

export function resolveWorkerModelSupport(options: {
	provider: string;
	modelId: string;
	/** The model as the dispatching session knows it; a custom id of a known provider may have none. */
	model: Pick<Model<any>, "name" | "runsOwnTools" | "delegatedHostTools"> | undefined;
	/** Whether the provider is switched on in the settings. */
	providerEnabled: boolean;
	extensions: readonly Pick<Extension, "path" | "resolvedPath" | "providers">[];
}): WorkerModelSupport {
	const label = options.model?.name || `${options.provider}/${options.modelId}`;
	if (!options.providerEnabled) {
		return {
			unavailableReason: `子智能体模型“${label}”所属的 Provider（${options.provider}）已停用，子智能体无法启动。${CHANGE_MODEL_HINT}`,
		};
	}
	if (options.model?.runsOwnTools && !options.model.delegatedHostTools) {
		return {
			unavailableReason: `子智能体模型“${label}”由它自己的程序执行工具，MyHarness 无法把它限制在子智能体的只读或沙箱范围内，所以不能用作子智能体模型。${CHANGE_MODEL_HINT}`,
		};
	}
	const extension = options.extensions.find((candidate) => candidate.providers?.has(options.provider));
	if (!extension) return {};
	// An extension built into the host process (`<inline:…>`) has no file a worker could load.
	if (extension.path.startsWith("<")) {
		return {
			unavailableReason: `子智能体模型“${label}”来自内嵌扩展，子智能体进程无法加载它。${CHANGE_MODEL_HINT}`,
		};
	}
	return { providerExtensionPath: extension.resolvedPath };
}
