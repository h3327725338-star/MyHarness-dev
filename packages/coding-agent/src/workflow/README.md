# workflow/ — 多阶段调查

## 说明

### 职责

实现 `workflow` 和 `ultracode` 两个工具背后的同一个执行引擎：按顺序执行若干阶段，每个阶段并行运行多个 Explore 子任务（只读模式下全部只读；读写模式下任务可用 `access` 标为只读或可写），后一阶段自动拿到前一阶段的结果。

阶段交接：每个阶段结束后，`phase-N.md`（有界结果，给下一阶段读）和 `phase-N-full.md`（完整结果）写进这次对话的产出目录 `workflow-runs/<时间>-<工具>-<名称>-<随机>/` 并保留；会话没有产出目录时退回系统临时目录，运行结束即删除。下一阶段每个任务的提示里带这个文件的绝对路径和 `summarizePhaseForNextPhase()` 生成的紧凑摘要；结果目录作为 `extraReadRoots` 交给 `runExploreBatch()`，进入每个任务的「可读清单」，guard 只放行 read/grep/find/ls/symbols 读它。`test/workflow-phase-read-roots.test.ts` 检查引擎让子代理读的每个路径都能通过子代理自己的权限检查。

| 文件 | 内容 |
| --- | --- |
| `engine.ts` | 输入 schema、阶段编排、阶段/整体超时、取消、进度明细、结果汇总；`createWorkflowToolDefinition()` 和 `createUltracodeToolDefinition()`；运行期控制 `WorkflowToolControls`（终止单个任务或整个 workflow） |
| `tool.ts` | 出口（原样导出 `engine.ts`） |

子任务本身由 `tools/sub-agent.ts` 的 `runExploreBatch()` 运行；两种工具的差异（名称、最少阶段数、说明）来自 `ultracode/profile.ts`。

### 依赖

- 依赖：`tools/sub-agent.ts`、`tools/contracts`、`tools/tool-definition-wrapper.ts`、`tools/tool-result-persistence.ts`、`ultracode/profile.ts`、`observability/runtime-trace.ts`。
- 被依赖：`tools/registry.ts`（登记工具）、`tools/presentation/public.ts`（展示出口，经由 `workflow/tool.ts` 转出引擎定义）、`agent/runtime`（保存运行期控制句柄）、`modes/web`。

## 维护

- 子任务不能再创建子 Agent；只读任务不能修改文件，写任务只能改自己的副本。这些约束由 `tools/sub-agent.ts` 的工具白名单、`tools/shell/read-only-guard.ts` 和 `tools/shell/delegated-write-guard.ts` 执行，改引擎时不要绕开。新增要子代理读的路径时，必须让它进入「可读清单」，并在 `workflow-phase-read-roots.test.ts` 里覆盖。
- 执行和展示分开：进度的数据结构在 `engine.ts`；展示出口在 `tools/presentation/public.ts`（转出本引擎的工具定义），具体前端渲染在 `web/` 与 `modes/web`。
- 主任务结束或被取消时，`AgentSession` 会通过 `WorkflowToolControls.killWorkflow()` 结束仍在运行的 workflow；新增控制能力时保持这条取消路径。
- 相关测试：`workflow.test.ts`、`workflow-phase-read-roots.test.ts`、`sub-agent.test.ts`、`test/suite/background-task-cascade.test.ts`。
