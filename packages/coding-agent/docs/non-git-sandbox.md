# 非 Git 子代理文件镜像

`agent`、`workflow` 和 `ultracode` 共用 `runExploreBatch()`。确认工作区不是 Git 仓库后，每个只读或读写任务从**镜像池**取一个普通文件副本，同步完成后才启动 worker。相对目录结构、中文和空格文件名保留；不自动初始化 Git，不创建宿主硬链接、符号链接或 Junction，不写回修改。Git 工作区的任务（只读和读写都一样）使用 Git 副本池（见 [设置](settings.md) 的 Sub Agent 一节）；Git 探测故障会明确报错，不冒充普通目录。

## 镜像池

池在 agent data 目录的 `sandboxes/<工作区路径的哈希>/` 下，每个副本是一个 `slot-<n>/`：`workspace/` 是 worker 的 cwd，`manifest.json` 记录每个文件在原工作区和副本里的大小与修改时间，`state.json` 记录上一个任务有没有留下改动，`warmed.json` 记录空闲预热读过哪些文件。占用锁在 `locks/slot-<n>.lock`（与 Git 副本池同一套锁：心跳续期，持有进程退出或 10 分钟没有心跳后可被接管）。

- 取副本：优先取空闲且干净的副本，再取空闲但有改动的副本；全部被占用时立刻新建一个，从不排队等待。新建的副本永久留在池里，不自动回收。
- 同步：只复制原工作区里新增或大小/修改时间变化的文件，并删除原工作区已经没有（或现在被过滤、超出预算）的副本文件。
- 复用前保存改动：上一个任务在副本里新建、修改或删除的文件先另存到 `saved/<slot>-<时间>/`（`files/` 放新建和修改的文件，`changes.json` 列出新建、修改、删除的路径；删除的文件内容已经不在，只能记录），然后才同步。依赖或构建缓存目录（如 `node_modules`、`dist`）里的文件可以重新生成，不复制，只在 `changes.json` 的 `notSaved` 里记录数量和前 200 个路径。保存位置会写进新任务结果的「未解决」，Main Agent 能看到。
- 只读任务（只读模式，或读写模式里 `access: "read"` 的任务）用只读工具集和只读 Shell 守卫；写任务的改动只留在副本里。
- 空闲预热：派发结束一段时间后（以及会话启动 60 秒后、仅当这个工作区已经有池时），把池补到「最大并发数」个副本；对空闲且干净的副本先同步到原工作区当前内容，再读一遍还没读过的文件，让杀毒软件在空闲时扫描，而不是在下一次派发时让 CPU 冲高。有改动的副本不动。派发开始时正在进行的预热会被中止。环境变量 `MYHARNESS_DISABLE_COPY_POOL_PREWARM=1` 关闭预热。

原工作区与池根目录互相包含时拒绝装配，不向原工作区写任何东西。

## 过滤

目录名在任意层级按完整名称、忽略大小写匹配，进入前就跳过：

- 依赖：`node_modules`、`bower_components`、`.venv`、`venv`。
- 构建产物：`build`、`dist`、`target`、`out`、`coverage`。
- 缓存：`.cache`、`.next`、`.nuxt`、`.turbo`、`.parcel-cache`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`__pycache__`、`.gradle`。
- 仓库及系统目录：`.git`、`.hg`、`.svn`、`$RECYCLE.BIN`、`System Volume Information`。
- 私密目录：`.ssh`、`.aws`、`.azure`、`.gnupg`。

文件排除：`Thumbs.db`、`desktop.ini`、`.DS_Store`、`id_rsa`、`id_ed25519`、`id_ecdsa`、`id_dsa`、`credentials`、`credentials.json`、`auth.json`、`.npmrc`、`.netrc`、`.pypirc`、以 `.key`/`.pfx`/`.p12` 结尾的文件，以及 `.env`/`.env.*`（保留 `.env.example`、`.env.sample`、`.env.template`）。`.myharness` 内另外跳过 `sessions`、`cache`、`trace`、`data` 和凭据文件。所有链接及非普通文件不复制、不跟随，包括坏链接和 Junction。

不按 PDF、Office、图片或源码扩展名排除，不泛化排除所有隐藏文件或 JSON。`build` 等名称可能包含任务输入；过滤项明确报告，不解释为宿主没有该文件。黑名单仅控制复制；当前文件工具仍能通过原工作区绝对路径补读，不代表凭据读取权限隔离。

## 预算与一致性

内置预算：单文件 256 MiB、累计 1 GiB、50,000 个目录项、深度 128、并发 4。不是新的用户设置。超过大小或深度限制、文件复制失败时记录镜像不完整；超过目录项预算或没有复制到任何可用文件且发生复制缺失时准备失败，不启动 worker。最多显示 20 条具体遗漏，其余用数量汇总。

异步、分块复制关闭所有文件句柄后才收尾；目录遍历使用显式栈，打开的目录自动关闭。源文件用不跟随链接的方式打开，复制前后核对类型、身份、大小和修改时间，变化的副本删除并记录遗漏；不宣称全目录原子快照，也不自动重试不稳定文件。云盘下载和大文件 I/O 会影响耗时，不保证任意工作区毫秒级装配。任务提示中提供文件数、字节数、本次实际复制和删除的文件数与耗时。

## 权限

worker 的 cwd 是副本的 `workspace`。相对路径读取及副本内写入沿用既有工具守卫；副本外 Shell 路径、宿主写入、Git 改库命令和嵌套派发仍禁止。原工作区和任务的「可读清单」（`readPaths`、workflow 的阶段结果目录）只能用 read/grep/find/ls/symbols 按绝对路径读取，没有给 bash/pwsh 增加这些位置的豁免。不加载普通项目扩展或项目上下文文件，沿用 delegated worker 的资源装配规则。工具层检查不是操作系统级安全隔离，脚本内部行为仍有原有边界限制。

## 旧的临时镜像

此前每个任务在系统临时目录 `myharness-delegated-sandboxes/` 下建一次性镜像、任务结束即删除。新派发不再使用它；`non-git-sandbox.ts` 仍保留原有导出（过滤规则、预算、兼容入口 `worktree-sandbox.ts`），启动延迟维护仍按原规则回收旧版本留下、父进程和 worker 都已退出且记录合法的临时镜像。

实现：`src/agent/delegation/mirror-pool.ts`（镜像池）、`slot-lock.ts`（占用锁）、`copy-pool.ts`（空闲预热调度）、`non-git-sandbox.ts`（过滤规则、预算、旧临时镜像）；批次编排：`src/tools/sub-agent.ts`。
