# MyHarness 安卓版（`packages/mobile`）

MyHarness 的安卓手机 App。它不是把桌面界面缩小，而是一套按手机重新做的界面，复用桌面 Web UI 的
基础模块（图标、文字、Markdown、对话分组等），外面包一层很薄的原生安卓壳。

## 它能做什么

界面是左右滑动的三栏：

| 位置 | 内容 |
| --- | --- |
| 左栏（向右滑） | 对话列表：搜索、新对话；“本机”按日期分组，“电脑”和电脑上的侧栏一样分组（见下）；顶部在“本机”和“电脑”之间切换；底部进设置 |
| 中间 | 对话与输入区：流式回复、思考与工具步骤折叠、停止 / 重试、附件、模型与 Thinking Effort 选择 |
| 右栏（向左滑） | 内置浏览器：地址栏、多标签、书签与历史、页内查找、桌面版网站、把当前网页交给助手 |

两种工作方式，在左栏顶部切换：

- **本机**：助手直接在手机上运行，用你自己填的模型服务（OpenAI Chat Completions、OpenAI Responses、
  Anthropic Messages、Google Gemini 四种协议，任何兼容服务都可以）。有三个工具：`web_search`（上网搜索）、
  `web_fetch`（读指定网页）、`browser`（操作右栏的内置浏览器），登录 Google 后还有 `memory_search`、
  `memory_get`（读电脑上的记忆）。对话保存在 App 自己的存储里，并经云端硬盘交给电脑保存（见下）。
  它没有命令行和文件系统，不会碰电脑上的项目。
- **电脑**：遥控电脑上的 MyHarness。你在手机上输入的内容发给电脑，由电脑上的模型、工具和文件来完成，
  回复同时显示在手机和电脑上。可以看电脑上的对话列表、打开对话、新建对话、停止、切换模型、回答电脑
  提出的询问、往电脑传文件（单个最大 16 MB）。左栏和电脑上的侧栏一样：顶部 Coding / General 切换，下面
  先是这个模式的各个工作区（可折叠，默认收起，正在看的对话所在的工作区自动展开），然后是“默认”（不属于
  工作区的对话）、“定时任务”和“副本中的对话”；每组先显示 12 条，置顶的在前、再是正在运行的，其余按最近
  活动排序。每个工作区和“默认”右边的 + 在那里新建对话。选的模式和各组的折叠状态记在手机上。
  发送时输入框立刻清空，消息先显示“正在发送”，电脑一收到就去掉（不用等电脑上的 Agent 准备好，比如挑选
  记忆）；发送失败时文字和附件放回输入框。

其他：拍照 / 相册 / 文件三种附件；从别的 App “分享”文字、链接、图片到 MyHarness；回复在后台继续生成
（前台服务）并在完成时通知；简体中文和英文；跟随系统的深色 / 浅色与三套配色；文字大小、动画和震动
可在设置里调整。

## 安装到手机

仓库不带安装包，需要先构建（见下一节），得到 `packages/mobile/dist/MyHarness-<版本>.apk`，然后任选一种方式：

- 把 APK 传到手机（数据线、网盘、聊天工具都行），在手机上点开安装。第一次需要在系统提示里允许
  “安装未知来源的应用”。
- 手机开启 USB 调试并连接电脑后：`adb install -r packages/mobile/dist/MyHarness-<版本>.apk`。

要求 Android 8.0（API 26）或更高。App 只有 Java 代码和系统 WebView，没有原生库，同一个 APK 适用于
arm64 手机和 x86_64 模拟器。

第一次打开是 Google 登录页，登录之前用不了别的功能：

1. 点“使用 Google 登录”，在手机浏览器里登录**电脑上 MyHarness 登录的那个 Google 账号**，允许页面列出的
   权限（包括云端硬盘）；登录完浏览器会带你回到 App。前提是至少有一台电脑已经用这个账号登录过
   MyHarness（设置 → Google 云端硬盘），否则 App 会提示先去电脑上登录。
2. 登录后自动出现：电脑上的模型服务连同 Key 和模型参数、电脑的默认模型和 Thinking Effort、电脑上的对话
   列表、记忆、内置浏览器的书签。不用在手机上再配一遍。
3. 想遥控电脑：见下面“连接电脑”。

在手机上新加或修改的模型服务也会交给电脑，电脑再同步到同一账号的其他电脑。Key 在手机上用安卓 Keystore
里的密钥加密保存，不进入页面存储；在云端硬盘里和电脑的 `auth.json` 一样是明文，由 Google 账号保护。
订阅类登录（OAuth）、来自环境变量或命令的 Key、Claude Code shell 这类电脑上的插件都不会到手机上。

## 连接电脑

**同一 Google 账号（推荐）**：左栏切到“电脑”，“你的电脑”里列出用同一账号登录、开着机并且打开了
MyHarness 的电脑，点一台就连上，不用扫码，也不要求在同一个网络。三条路同时尝试，哪条先通用哪条：电脑开了
局域网连接时的局域网、经互联网直连（WebRTC）、经你的 Google 云端硬盘中转（比直连慢，一来一回一两秒到几秒，看网络）；中转先通而直连
随后也通时，自动换到直连。连接中显示已经用了几秒、还在试哪几条路；连上后走的是哪条显示在 设置 → 连接电脑 里。
停在中转上时，每 2 分钟和手机换网络时再试一次局域网和直连；设置 → 连接电脑 里写着上次直连为什么没成（比如这台
手机所在的网络没有 IPv6 地址）。
电脑一侧可以在 设置 → 手机 → “同一 Google 账号的手机”里关掉，或者移除某台手机（移除后它要重新登录 Google 才会
再出现）。

App 一打开就在后台连上次用的电脑（在“本机”一侧也连），等切到“电脑”时已经连好；第一次登录后，如果账号里只有
一台电脑开着，就直接连它，不用点。在 设置 → 连接电脑 里断开后，就不再自动连。切到后台 1 分钟后断开（不再
读云端硬盘），回到前台时马上重连。手机访问云端硬盘的每个请求都有时限（连接用的小文件 10 秒，其他 30 秒起），
手机换网络后断掉的连接由原生网络层每 5 秒一次的心跳发现，不会让连接卡住几分钟。

**局域网 + 二维码（保留）**：

1. 电脑上打开 MyHarness → 设置 → 手机，打开“手机连接”。第一次开启时 Windows 防火墙可能询问是否允许
   MyHarness 被网络访问，对“专用网络”选择允许。
2. 手机和电脑连同一个 Wi-Fi 或局域网。
3. 电脑上点“显示配对二维码”；手机上左栏切到“电脑”→“改用二维码配对”（没有登录时是“连接电脑”）→ 扫码。
   扫不了时，电脑上可以复制配对码，手机上选择粘贴。

二维码只能用一次，十分钟内有效。局域网连接时手机和电脑直接通信；每条消息都用这台手机的密钥加密
（AES-256-GCM：扫码时来自二维码，账号登录时由手机自己生成并登记在云端硬盘里）。配对后的手机可以读电脑上的对话并让电脑上的 Agent 执行操作，所以只配对
自己的手机；在电脑的同一个设置页可以随时移除某台手机或关掉手机连接。协议、允许的接口和安全模型
写在 [Web UI 文档的“手机连接”一节](../coding-agent/docs/web-ui.md#手机连接)。

局域网连接默认关闭；同一账号的远程连接在电脑登录 Google 后默认开着。远程连接没有 TURN 服务器，有些网络
（尤其手机流量）走不通直连，这时自动改走云端硬盘中转。

## 构建

构建需要 JDK 17 和 Android SDK（`platforms;android-37.0`、`build-tools;37.0.0`、`platform-tools`）。
`build.mjs` 按以下顺序找它们：

1. 环境变量 `JAVA_HOME`、`ANDROID_HOME`（或 `ANDROID_SDK_ROOT`）；
2. `%LOCALAPPDATA%\MyHarnessAndroid\jdk` 和 `%LOCALAPPDATA%\MyHarnessAndroid\sdk`。用这个目录时，Gradle 和
   SDK 的缓存也放在它下面（`gradle-home`、`android-home`），删除整个 `MyHarnessAndroid` 目录就清干净了。

已经装了 Android Studio 的电脑把两个环境变量指过去即可。没有的话，下载 Temurin JDK 17 和 Android
“Command line tools”，用 `sdkmanager` 安装上面三个包（需要接受 Android SDK 许可协议）。Gradle 由
`android/gradlew` 按 `gradle-wrapper.properties` 自动下载，依赖从 Google Maven 和 Maven Central 下载，
所以第一次构建需要网络。

在仓库根目录执行：

```powershell
node packages/mobile/build.mjs            # 只生成 App 内的页面（android/app/src/main/assets/www）
node packages/mobile/build.mjs --apk      # 页面 + 签名的正式 APK → packages/mobile/dist/MyHarness-<版本>.apk
node packages/mobile/build.mjs --debug    # 页面 + 调试 APK（页面可被 chrome://inspect 检查，签名与正式版不同）
```

- **签名密钥**：第一次构建正式 APK 时，会在 `~/.myharness/android-signing/` 生成一个密钥库和
  `signing.properties`（位置可用 `MYHARNESS_ANDROID_SIGNING_DIR` 改）。安卓只允许用同一把密钥签名的
  新版本覆盖安装旧版本，所以这个目录要留好并自己备份；丢了之后只能先卸载 App（本机对话会一起删除）
  再装新版本。密钥不在仓库里，也不能提交进仓库（`android/.gitignore` 已排除 `*.jks`、
  `signing.properties`）。
- **版本号**：取 `packages/mobile/package.json` 的 `version`；安卓要求的整数版本号由它算出
  （`0.0.8 → 8`，`1.2.3 → 10203`）。发新版本前先把 `version` 调大，否则手机不会当作升级。
- 调试 APK 和正式 APK 的包名相同、签名不同，互相不能覆盖安装，换装前要先卸载。
- 生成物（`dist/`、`android/app/build/`、`assets/www/`、`*.apk`）都被 Git 忽略。

## 开发

```powershell
node packages/mobile/dev-server.mjs            # 在电脑浏览器里预览手机页面（默认 http://127.0.0.1:8765）
node --test packages/mobile/test/*.test.mjs    # 本包的测试；根目录 npm test 也会跑
```

预览时把浏览器开发者工具切到手机尺寸。安卓壳提供的能力在预览里用替身代替：网络请求由预览服务代发
（所以不受跨域限制，和 App 里一致），密钥存在浏览器存储里，内置浏览器只显示占位。预览服务只监听
`127.0.0.1`。Google 登录只能在 App 里做（它要原生的本机回调），所以预览的登录页多一个“预览：不登录直接
继续”。

目录：

| 路径 | 内容 |
| --- | --- |
| `web/` | 手机页面：`index.html`、`css/`、`js/`（Preact + htm，不需要打包步骤） |
| `src/core.ts` | 手机本机 Agent 用到的那部分 `packages/agent`、`packages/ai`，由 esbuild 打成 `js/core.bundle.js` |
| `shared-files.mjs` | 从桌面 Web UI 原样复用的文件清单；预览服务和构建都读它，两边不会不一致 |
| `build.mjs`、`dev-server.mjs` | 构建和预览 |
| `android/` | Gradle 工程和 Java 源码（`com.myharness.mobile`） |
| `test/` | `node --test` 测试：两端加密互通、事件归并、构建清单、中文文案覆盖、账号视图（电脑列表、多台电脑的视图合并、电脑对话与手机格式互转、记忆搜索）。电脑一侧的 `packages/coding-agent/test/phone-channel.test.ts`、`phone-remote-link.test.ts` 也直接加载本包的 `account-view.js`、`link-remote.js` |

页面模块（`web/js/`）：

- `main.js` 启动和三栏装配；`pager.js` 三栏滑动（跟手、弹簧动画、方向锁定）；`sheets.js` 底部弹层和整页。
- `drawer.js`、`chat.js`、`composer.js`、`transcript.js`、`browser.js`、`settings.js` 是六个界面区域。
  “电脑”一侧的对话列表是 `pc-chats.js`（模式切换和分组），分组规则在不碰界面的 `pc-groups.js` 里（与桌面
  侧栏同样的分组、排序和隐藏空白对话的规则，`test/pc-groups.test.mjs` 测它）。
- `backend-local.js` 本机 Agent；`backend-remote.js` 电脑遥控；`backends.js` 在两者间切换。两个后端说同一套
  事件（`message_start`、`tool_start`…，与桌面 Web UI 相同），由 `live.js` 归并成页面状态，所以同一份对话
  界面两边通用。
- 账号：`signin.js` 登录页；`google.js` Google 登录（PKCE + 本机回调 `http://127.0.0.1:<端口>`，refresh token
  存在 Keystore 加密的密钥里）；`drive.js` 云端硬盘客户端（只碰 `MyHarness/phone-v1/` 和按哈希读
  `sync-v1/objects/`）；`account.js` 登记本机、每 30 秒读电脑列表与视图、发 outbox；`account-view.js` 是不碰
  网络的部分（合并多台电脑的视图、电脑对话与手机格式互转、记忆搜索）；`link-remote.js` 经云端硬盘交换信息的
  直连与中转。布局和规则见 [google-drive-sync.md 的 “Phones of the account”](../coding-agent/docs/google-drive-sync.md#phones-of-the-account)。
- `native.js` 是页面与安卓壳之间唯一的桥；`tools.js` 是本机的三个工具；`link-crypto.js` 是手机连接的加密
  （Web Crypto，与电脑端 `phone-link/crypto.ts` 一一对应）。
- `locale-zh.js` 是手机独有文案的中文；和桌面共用的文案直接用桌面的 `locales/zh-CN.js`。新增界面文字
  必须同时加中文，`test/build.test.mjs` 会检查。

安卓壳（`android/app/src/main/java/com/myharness/mobile/`）：

| 文件 | 职责 |
| --- | --- |
| `MainActivity.java` | 单 Activity：承载页面的 WebView、系统栏与键盘的边距、文件 / 相机 / 扫码、分享与链接、返回键 |
| `HttpBridge.java` | 页面的网络请求（OkHttp，流式返回）。模型服务和搜索都不支持浏览器跨域，所以请求由原生发出 |
| `BrowserController.java` | 内置浏览器：每个标签一个原生 WebView，盖在页面的浏览器区域上 |
| `PagerLayout.java` | 浏览器显示时，把从屏幕左边缘开始的触摸交回页面，用来滑回对话 |
| `RunService.java` | 回复生成期间的前台服务和“回复好了”通知 |
| `SecretStore.java` | 用 Android Keystore 的密钥加密保存 API Key、手机连接密钥和 Google 的 refresh token |
| `OAuthLoopback.java` | Google 登录的本机回调：只在 `127.0.0.1` 的随机端口上等一个请求（最多 10 分钟），把结果交给页面，再用 `myharness://signed-in` 把浏览器带回 App |
| `SignInService.java` | 等 Google 登录期间的前台服务（通知“正在等待 Google 登录”）：浏览器在前台时，安卓会在几秒到一两分钟内冻结后台的 App，本机回调就收不到浏览器的请求，浏览器一直转圈；回调结束、出错、超时或取消时就停 |

本机助手的提示词是 `system-prompts/mobile/identity.md`，构建时和通用的输出语言、对话标题提示词一起嵌入
页面（`js/prompts.generated.js`）。

## 权限

| 权限 | 用途 |
| --- | --- |
| `INTERNET`、`ACCESS_NETWORK_STATE` | 访问模型服务、搜索、网页和电脑 |
| `CAMERA` | 拍照作为附件、扫描配对二维码；只在用到时询问 |
| `POST_NOTIFICATIONS` | 回复完成通知、生成期间和等待 Google 登录期间的常驻通知；只在第一次需要时询问（不允许时服务照样运行，只是不显示通知） |
| `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC` | App 在后台时让正在生成的回复继续；Google 登录时浏览器在前台，App 在后台等登录结果 |
| `VIBRATE` | 震动反馈 |

App 允许明文 HTTP（`usesCleartextTraffic`）：手机连接走局域网 HTTP（内容本身已加密），Google 登录的本机
回调是 `http://127.0.0.1`，局域网里自建的模型服务和内置浏览器打开的 `http://` 网页也需要它。系统备份已关闭（`allowBackup="false"`），本机对话和
密钥不会被带到别的设备。

## 已知限制

- 只有安卓，没有 iOS。只做了竖屏。
- 本机助手只读图片和文本类文件（代码、Markdown、CSV 等，单个 400 KB 以内）；Word、PDF 等要切到“电脑”
  发给电脑处理。
- 本机对话没有上下文压缩：超出模型窗口时从最早的整轮开始不再发送（界面上仍然保留）。
- 手机上的对话和模型服务改动先放在云端硬盘的 outbox 里，要等同一账号的某台电脑开着 MyHarness 才会被写进
  电脑、再同步到其他电脑；电脑的对话列表和视图也是电脑写的，电脑都关着时手机看到的是上一次的内容。
- Google 登录借用的是 MyHarness 桌面端的 Google 应用（“桌面应用”类型的 OAuth 客户端），这样手机和电脑在
  `drive.file` 权限下能看到同一个文件夹；Google 不保证这种用法长期可用。真机上 Google 的授权页能正常打开，
  完整的登录和登录后手机能否看到电脑的文件夹还没有验证过。
- 远程直连没有 TURN 服务器，走不通时改走云端硬盘中转（慢）；直连时 Google 的公共 STUN 服务器会看到手机
  和电脑的公网地址。
- 电脑遥控不包含电脑端的终端、Git、文件面板、设置和定时任务的管理（定时任务产生的对话可以看），只有对话相关的操作；
  新建对话只能放在电脑上已有的工作区里或“默认”里，不能新建工作区。
- 内置浏览器是系统 WebView：没有扩展，网页的下载交给系统处理，网页内弹出的新窗口在新标签里打开。
- 内置浏览器里，网页区域的触摸归网页；回到对话用系统返回（先退网页历史）、在地址栏或底部工具栏上
  横滑，或点左上角的返回。
