# UWork_frontend 追上游 ZCode 3.18.1 —— 总计划

> 2026-11-13 制定。基线：`main` `f6dda23d`（0.1.9）；上游：`zai-org/ZCode` `c5904686`（v3.18.1）。
> 前端仓与上游**无共同祖先**（起点整树 squash），口径一律是「三边内容比对」：
> base = 上游 3.16.2 快照 `3c5b2276`，ours = 本仓，theirs = 上游 3.18.1。
> 判定：ours==base ⇒ 取上游；ours!=base ⇒ 冲突，人判。

## 〇、已量出来的事实（不要再重算）

- 上游从 3.16.2 到 3.18.1：**3350 个已有文件被改**（其中 2963 我们没动 → 可直接取）+ **3061 个新增** + **2371 个被删**。
- 需要人判的：**341 个双方修改冲突**、46 个我方已删但上游改过、279 个上游删但我方改过。
- 全量机械部分已在 `chore/upstream-3.18.1-sync`（7946 文件，+588k/−534k），落地后 typecheck **1186 错**。
- 头部能力合计 **215 文件（196 纯新增）**，占上游改动面 **2.5%**。

## 一、已确认的三个结构性结论

1. **核心契约是总闸**：`session-control` / `app-control` / `extension-host` 依赖上游新的
   `protocol-v4`（`WireConversationRow` 等）与 `extension-host` 契约；承载导出的 5 个
   barrel（`shared/package.json`、`shared/src/index.ts`、`shared/src/zcode-protocol/index.ts`、
   `services/src/index.ts`、`services/package.json`）**都是我们定制过的冲突文件**。
2. **上游 `shared/src/index.ts` 不能整取**：它是整树级联出口，整取会把几十个我们还没有的
   模块一起导出（实测 114 → 199 错）。做法：保留我方 barrel，**按需加导出**。
3. **zod 必须单实例**：新包钉 `zod 4.6.5` 与仓库 `4.6.6` 会生成嵌套副本，产生成片
   "not assignable to ZodType" 假错。新包一律对齐到仓库版本；改完记得清 `*.tsbuildinfo`。

## 二、阶段与依赖

```
P0 核心契约（阻塞一切）
  └─> P1 语言包（可并行，落点分散）
  └─> P2 特性移植（每个独立分支，依赖 P0 的契约）
        ├─ Session 管理（已 195 文件，等 P0）
        ├─ Worktree 并行任务（49 文件）
        ├─ Design / design-runtime（40 文件）
        ├─ 语音输入（31 文件）
        └─ 内置浏览器点选/导出（7 文件）
  └─> P3 第二波小特性（工具分组、归档删除、图片预览菜单、分享有效期…）
  └─> P4 收口（lint/architecture/测试基线对照、PR）
```

**P0 是唯一阻塞项**；P1 与 P2 的每个特性互相独立，可并行。

## 三、每阶段的做法与完成定义

### P0 核心契约（分支 `chore/upstream-core-contracts`）

已完成：`session-control` 整包、`locale.ts`、`protocol-v4/**`、`protocol/plugin-host-queries/**`、
`extension-host/**`、`app-control/**`、Locale 五语言、依赖声明、zod 对齐。

剩余：
1. 按 typecheck 错误补 `shared` 里被上游引用但缺失的模块（`userInstructions`、
   `env`/`platform` 新常量等，预计 10–20 个纯新增文件）；
2. 在**我方** `shared/src/index.ts` 手工加导出：`./locale.js`、`./extension-host/*`、
   `./app-control/*`、`./zcode-protocol-v4/*` 中实际被引用的那几个；
3. `services/src/index.ts` 同理；
4. 绿：`pnpm typecheck` 0 error、`pnpm architecture:check` 0 违规、`pnpm lint` 0 error。

**完成定义**：core 分支 typecheck 0 错，且 `shared`/`services` 的公共面只增不改语义。

### P1 语言包（分支 `feat/upstream-i18n-langs`）

已完成：`locale.ts`、`Locale` 五值、`localeMessages.ts`、`IntlProvider`、ja/ko/ru 三份词表。

剩余：约 10 处 `Record<Locale, …>` 字面量（`desktopMenu`、`conversation-share`、`about`、
`platformUpdate`、`remoteAppConfig`、`desktopOAuthDeepLink`、`bots`、`builtinSkillI18n` 等）
补三种语言条目——**策略**：优先用上游译文；若该文件我方定制过（冲突），则复制 `en-US` 条目作兜底
并在条目上注明「暂用英文」，避免拉进 protocol-v4 的改写。

**完成定义**：typecheck 0 错；`IntlProvider` 能选中五种语言；未知语言回退 en-US。

### P2 各特性（每个一条分支，从 main 起）

统一手法（已沉淀为 `/tmp/apply-feature.mjs`，可复用）：
1. 用路径正则从 `git diff --name-only 3c5b2276 refs/upstream-main` 取该特性的候选文件；
2. 上游新增 / 我方未动 → 直接取；两边都改 → `git merge-file` 三方合并；我方删过 → 跳过并记录；
3. `pnpm install` → `pnpm typecheck` 逐个收错（缺模块补模块、缺导出补导出）；
4. 绿了跑 `lint` + `architecture:check` + 该特性的定向测试。

顺序建议（依赖由弱到强）：**内置浏览器（7）→ Design（40）→ 语音（31）→ Worktree（49）→ Session 管理（195，等 P0）**。

**完成定义**（每个特性）：typecheck 0、arch 0、定向测试通过、PR 描述里列出"从上游取了哪些文件、改了什么接缝"。

### P4 收口

- 全量测试必须**先跑基线对照**（本仓基线自带大面积红，报告前要证明"零新增失败"）；
- `pre-push` 要带显式基线跑（`ZCODE_PRE_PUSH_BASE` / `ZCODE_AFFECTED_TEST_BASE=origin/main`）：仓库里没有 `origin/staging`，不带基线才会报「找不到基线」。（2026-11-24 更正：这里原先写「只能 `--no-verify`」，不成立。）
- 分支矩阵与顺序写进 PR 描述，方便评审按特性逐个验收。

## 四、并行编排

| 轨道 | 分支 | 工作树 | 依赖 |
| --- | --- | --- | --- |
| A 核心契约 | `chore/upstream-core-contracts` | `UWork-frontend-core` | 无（总闸） |
| B 语言包 | `feat/upstream-i18n-langs` | `UWork-frontend-i18n` | 弱（只碰词表） |
| C 特性批次 1 | `feat/upstream-browser-export` | `UWork-frontend-browser` | 弱 |
| D 特性批次 2 | `feat/upstream-worktree` | `UWork-frontend-worktree` | 中（等 A 的 shared） |
| E 特性批次 3 | `feat/upstream-design` | `UWork-frontend-design` | 中 |
| F Session 管理 | `feat/upstream-session-control` | 已有 | 强（等 A） |

规则：**同一时刻一个工作树只跑一条轨道**；跨轨道的公共文件（`shared/src/index.ts`、
`services/src/index.ts`、`package.json`、`pnpm-lock.yaml`）只在 A 轨改，其它轨道等 A 合并后 rebase。

## 五、风险与止损

- 上游 3.17/3.18 是大重构；任何一条特性如果"补模块"超过 30 个文件，**立即停**、回到 A 轨先把契约做全；
- 全量路线（`chore/upstream-3.18.1-sync`）始终保留，作为"产品线愿意整体重新验收"时的现成起点；
- 每条分支只在**自己绿了**之后才合并；不绿的分支只做 WIP 提交，不推 PR。

## 4.0.0 增量（2026-11-24）

### 上游变化概述

- 上游在这条分支的基线（3.18.1 `c5904686`）之后又走了两版：
  - **3.18.2** `fec97590`：补丁版，46 文件（+1971/−171），以修复与测试为主；
  - **4.0.0** `a4b44451`（= `refs/upstream-main`）：2209 文件（+149753/−24801）。
- 4.0.0 的主体是**新增「预装文档工具」子系统**（`packages/desktop/src/preinstalled-tools` 等 17 个新源文件、
  `docs/issues/preinstalled-tools` 与 `docs/issues/document-tool-preinstall` 规格与评审记录），
  以及 **GLM-5.4 预置（模型注册表）**；其余是若干修复：
  会话删除批量预检、动态工作流灰度读取失败时的提供值、项目换证传输故障的 RPC 错误码、
  分享被服务端拒绝时的结构化坐标、`turn.started` 兼容字段、回复语言读取、插件商店按区域展示等。

### 对我方的影响面（已量）

- 五条分支合计 **883 个文件**（我方相对 3.18.1 改动过的文件），其中 **125 个被 4.0.0 再改**；
- 125 个里：**41 个可直接取**上游、**71 个自动三方合并**、**51 个有冲突**（需人判）、**2 个上游已删**；
- 本分支（核心契约 A 轨）落点 20 个文件，实际冲突 6 个文件 / 16 块。

### 本分支这一波做了什么

- 以 3.18.1 为 base 叠 4.0.0 增量（`/tmp/apply-delta.mjs`，清单 `/tmp/up4-delta-core.txt`）：
  直接取 8 个、三方自动合并 6 个、冲突 6 个（16 块）。
- **取上游的功能性改动**：protocol-v4 契约（`delta`/`snapshot`/`telemetry`/`transport`/`sessions-index`/
  `session-data`）；分享被服务端拒绝的结构化映射（rule → issue code + 坐标 + `artifact_id`/`actual`/`limit`，
  含 UI 文案与两份语言表）；`session/readReplyLanguage` 与 `artifact_id` 反查；项目换证传输故障改用
  `-32033` 结构化错误码；`turn.started.isFirstMessage` 兼容字段；`workspace_hook_script_unavailable`。
- **保留 UWork 定制**：品牌文案（`UWork provider runtime headers …`）、`toZhOrEnLocale` 的五语言收窄、
  我方 `ProjectAccessToken*` 契约（用 `ProjectAccessTokenTransientError` 判定传输故障，不引上游的
  `isProjectTokenTransportFailureCode`）、精简后的 `ModelProviderSection` / `ProviderTemplatePicker`
  （不恢复官方模板分区）、`V4InteractionDialogs` 的既有交互形态。
- **刻意没取**：
  - 预装文档工具子系统（连带 `shared/package.json` 的 `./preinstalled-tools*` exports）、GLM-5.4 注册表、
    插件商店区域化 UI；
  - 需要新子系统的 4.0.0 特性：远端会话遥测引擎（`@zcode/shared/conversation-telemetry` 整目录未移植）、
    context-composition 客户端、plugin-host-queries 客户端、credential-cipher RPC（`credential-security`
    只有契约导出目标、实现未移植）、会话删除/项目数据清理 RPC 与 workspace-plugin-trust RPC
    （它们的实现会撑大我方刻意收窄的 `IZCodeAgentService`）、插件推荐埋点 mapper；
  - 与 UWork 自有契约/测试冲突的两处行为变更：动态工作流「读取失败按 onDemand」、runtime 偏好新增
    `totalTokensReminderEnabled`/`agentAlwaysBackgroundEnabled`（UWork 测试固化了 fail-closed 与原线格式）。
  - 协议层保留上游线格式（`workspaceTrust`、`plugins/workspaceTrust`、`regions` 等）以容忍 `.strict()`
    schema 下的新载荷，但**不实现**对应功能。
- 为编译必需而补的 5 个非清单文件：`services/.../conversationShare.ts`（拒绝码与 `rejection` 字段）、
  `ui/src/lib/conversationShareError.ts`（issue 文案映射与 retry 判定）、`ui` 的 `zh-CN`/`en-US` 词表、
  `shared/src/validationAppSettings.ts`（`replyLanguageSchema`）。
- 门禁：typecheck 0 错、architecture 0 违规、lint 0 error（336 warning，与基线一致）；
  定向回归（conversation-share 37 文件 466 例、local-ttft、officialMcp*、feedback、v4InteractionDialogs、
  taskNotification、about）全过；另跑 zcodeAgent/providerRuntime/conversationTelemetry 28 文件 466 例全过。
  基线自带的 5 文件 8 例红（`zcodeProtocolV4Command`、`zcodeProtocolV4DisplayTolerance`、
  `modelProviderDraftSave`、`modelProviderRestart*`）经 `git stash` 对照确认为既有失败，非本次引入。
- 依赖与锁文件：零变化（唯一 `package.json` 改动是上游 exports，已按“不移植”裁掉；`pnpm install` 无 diff）。

### 后续四条特性分支（rebase 到本分支，再叠各自增量）

顺序按依赖由弱到强；每条分支先 rebase 到 `chore/upstream-core-contracts`，再跑各自的 `apply-delta`：

| 轨道 | 分支 | 需叠 4.0.0 增量文件数 | 备注 |
| --- | --- | --- | --- |
| C 特性批次 1 | `feat/upstream-browser-export` | 7 | 弱依赖；可先起 |
| E 特性批次 3 | `feat/upstream-design` | 28 | 中依赖 |
| F Session 管理 | `feat/upstream-session-control` | 37 | 强依赖，等本分支合入 |
| D Worktree | `feat/upstream-worktree` | 32 | 中依赖 |

统一做法：`node /tmp/apply-delta.mjs <名称> '@/tmp/up4-delta-<名称>.txt' refs/upstream-3.18.1 refs/upstream-4.0.0`，
冲突按「UWork 定制优先、上游功能改动照收、需要新子系统就跳过并记录」处理；每条分支绿了再合。

### 集成结果（`integration/upstream-4.0.0`，2026-11-24）

基线 `cf6dc444`（core 契约），四条特性分支用 `git merge --no-ff` 按
session → worktree → design → browser 叠放，每次合并一个提交、每合完一条清 `*.tsbuildinfo` 再跑
`pnpm typecheck`。四条合在一起无结构性冲突：**1 处文本冲突在 worktree 的 core `runtime/types.ts`，
1 处在 design 的根 `package.json`；browser 与 design 在 `UnifiedBrowserView.tsx` 上落在不同 hunk，
自动合并后逐行核对为并集**。

**四条分支各自取了什么 / 舍弃了什么**

- **Session 管理**（`feat/upstream-session-control`，+178 文件）：取 session-control + app-control +
  extension-host 契约、core 工具面注册与执行装配、`ReadSession` 的冷会话 forward 分页、
  standalone CLI app 工厂 / protocol 物化 / TUI 审批；舍弃 4.0.0 里依赖未移植子系统的实现
  （远端遥测、MCP catalog registry、content profile、plugin host）。
- **Worktree 并行任务**（`feat/upstream-worktree`，+116 文件）：取受管 worktree 全栈（shared 布局与
  Hook Trust identity、services git 子进程加固 + 编排服务、UI 创建视图 / composer 开关 / fork 目的地 /
  侧栏创建行、CLI `createSession.cwd` / `forkAssistant.targetCwd` / `releaseUnderDirectory` / 时间线落盘）
  与 4.0.0 的 CR-01 远程 identity 修复；舍弃依赖未移植导航的 WT-41 审核入口与 `hookWorkspacePath`。
- **Design**（`feat/upstream-design`，+536 文件）：取 design-runtime 页面运行时、design-plugin 0.8.0
  （含 4.0.0 的 audit 脚本与夹具，按上游字节保真）、内置浏览器设计模式（点选 / 属性面板 / 源码写回 /
  live reload / undo 快捷键）；舍弃预装文档工具子系统、文档插件版本跳跃（0.2.10/0.2.11）、
  voice-input / 快捷键内核 / 草稿模型迁移。
- **浏览器导出**（`feat/upstream-browser-export`，+17 文件）：取 main 侧 `captureBrowserGuestPage`
  与 PNG/PDF 导出全链路（shared 契约 + 通道 + preload/bridge + UI hook 与工具栏菜单）；舍弃 renderer 侧
  `capturePage`（V8 FATAL，只能由 main 取帧）。

刻意取舍在四条分支间一致、未被合并带回来：**无 `#preinstalled-*` 导入**、无 GLM-5.4 注册表、
无地区化插件商店、无 MCP 会话重做、无 credential-cipher；**zod 4.6.6 单实例**（各 workspace 均解析到
根 `node_modules/zod`）。

**门禁（集成分支实测）**

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck`（先清 `*.tsbuildinfo`） | 0 error |
| `pnpm architecture:check` | 0 违规（baseline 0 / new 0） |
| `pnpm lint` | 0 error / **351 warning**（基线 336 + design 字节保真脚本 15：`audit-page.js` 11、`audit.mjs` 3、`probe.js` 1） |
| `pnpm db:schema:check` | 通过（8/8 契约例 + 两份 schema baseline 兼容） |
| `pnpm test:architecture` | 43/43 |
| CLI 子工作区 typecheck（contracts / core / bootstrap / tui / cli） | 全部 0 error（worktree 单独时的 4 个 bootstrap `TurnInputSourceMetadata` 错误被 session 的装配修掉，合并后不再出现） |

**回归（四条分支绿过的集合并集，去重后 1,302 例）**

> 去重口径：browser 行与 design 的 UI 行重叠 `UnifiedBrowserView` 81 + `BrowserUseSidePaneContent` 8
> 共 89 例，已扣掉。各分支自己的口径：session 376、worktree 571、design 277、browser 167。

| 来源 | 例数 | 结果 |
| --- | --- | --- |
| session：`@zcode/session-control` 包 | 103 | 全绿 |
| session：core `tests/session-control` | 24 | 全绿 |
| session：core `tests/tool-search` + `tests/session-control` | 212 | 全绿 |
| session：bootstrap `tests/cli-session-control` 配置 | 15 | 全绿 |
| session：bootstrap `tests/session-control`（app-client 5 / protocol-binding 14 / standalone-process e2e 1 / standalone-tui-approval e2e 2） | 22 | 全绿 |
| worktree：`v4-worktree-cwd` 8 + `workspace-hook-trust-managed-worktree` 6 + `worktree-creation-timeline` 2 + `pre-push-worktree` 6 | 22 | 全绿 |
| worktree：UI SessionPane/Shell/worktree 引用集（39 文件） | 549 | 全绿 |
| design：design-runtime contract 6 + design-plugin 4 文件 58 | 64 | 全绿 |
| design：UI（UnifiedBrowserView 81 / BrowserUseSidePaneContent 8 / useWorkspaceServices 52 / useComposerAttachmentsAddToChatGate 3 / composerSubmissionSettlement 5） | 149 | 全绿 |
| design：services `fileService` | 64 | 全绿 |
| browser：browser 一族 12 文件（含 `embeddedBrowserHelpers` 11、`UnifiedBrowserView` 81、`BrowserUseSidePaneContent` 8） | 167 | 全绿 |

既有失败（与本轮无关，逐项与基线对照一致）：`tool-input-validation-error.test.ts` 2 例、
`runtime-hooks.test.ts` 1 例、`projectSidebarExpansion` + `projectSidebarHomeOnlyWorkspaces` 共 11 例
（`storage?.getItem is not a function`，Node 25 localStorage 环境）、
`packages/desktop/test/desktopMainIpcPlatform.test.ts` 1 例。除此之外无新增失败。
`design-plugin/test/audit.test.ts`（45 例，需本机 Chrome，约 17 分钟）**默认未跑**。

> ⚠️ 下面这段对照跑在 Node 25.5.0 上、只比过 core 分支与集成分支，结论已被本节末尾的
> 「按仓库口径复核（2026-11-24，Node 24.14.0、净化环境）」取代——以那一节为准。

另做了一次**全量 `--project unit` 对照**：在 `/tmp/uw-baseline`（`git worktree add --detach`）分别跑
`cf6dc444` 与集成分支，失败集合逐条比对：

| 树 | 失败文件 | 失败例 | 通过例 |
| --- | --- | --- | --- |
| 基线 `cf6dc444` | 71 | 256 | 19940 |
| 集成分支 | 67 | 256 | 19953 |

失败集合只差一条：`packages/ui/test/v4ConversationRowViewUserEdit.test.ts > renders prompt contexts in
the edit second row…`（期望 `## Element undefined`、实际 `## Element 1`）。用 `550a0dcf` 单跑确认它
**在 design 分支上就红**（39/39 → 38/39）：design 把 `## Element N` 的编号提为必需字段
（`WebElementContextComposerAttachment.ordinal`），但 `packages/ui/test` 不在根 typecheck 的工程里，
夹具没跟着改。已在集成分支补 `ordinal: 1`（`d810bdbe`），该文件回到 39/39；另 5 个只在基线红的文件是
Node 25 环境抖动（`e2eReporting*` 等），集成分支上通过。**全量对照的结论：没有集成引入的失败。**

**仍然挂着的缺口**

1. `design-plugin/test/audit.test.ts` 45 例需本机 Chrome，未纳入本轮回归；CI 上要单独一条带浏览器的作业。
2. browser 分支的 `packages/ui/test/browser/manual-review/**`（`.test.mjs`，浏览器验收夹具）不在根
   vitest 的 `unit` include 内，本轮未跑。
3. 4.0.0 里依赖未移植子系统的能力（远端遥测、context-composition、plugin-host-queries、
   credential-cipher、workspace-plugin-trust、预装文档工具、GLM-5.4 注册表、地区化插件商店）
   仍是有意留空，集成分支不改变这个边界。
4. 集成只保证「四条特性 + 4.0.0 基线」自洽；`main`（0.1.9）与这条集成分支之间没有可自动判定的等价关系，
   落地时需要按下一节的交付方式决定顺序。

**交付方式（三选一）**

1. **core 单独一个 PR + 四条特性各一个 PR**（推荐）：`chore/upstream-core-contracts` 先合，四条特性按
   session → worktree → design → browser 的叠放顺序逐个 PR。每条 PR 的 diff 已经天然是「本特性 + 与前面
   特性的并集」，review 面最小；代价是四次 rebase 与四次门禁，但每次都能独立回滚。
2. **整体一个 PR**：`integration/upstream-4.0.0` 一次性合入。review 面 800+ 文件，冲突解法集中在两个合并
   提交里可读，但只能整体回滚。
3. **core + 一个「特性批次」PR**：core 单独合，四条特性合成一个 PR。折中方案；适合只想让 review 看到
   「契约」与「特性」两层的情况，代价是特性之间无法单独回滚。

### 按仓库口径复核（2026-11-24，Node 24.14.0、净化环境）

上一版的「全绿」不合格，错在三处：跑在 Node 25.5.0 上（本机没有 mise，误用了 Homebrew 的 Node）、
只挑了自己的回归集、`architecture:check --changed` 的 191 条被当成「只影响 pre-push」。这一轮按仓库
自己的方式重来：Node 取 `mise.toml` 钉的 24.14.0（官方发行包，SHA256 校验后装在
`~/.local/share/uwork-toolchain/`）；测试在 `env -i` 净化过的环境里跑（桌面应用会导出二十多个
`ZCODE_*` 变量，其中一个 CUA Helper 路径能让用例假绿）；检查清单以 `.github/workflows/desktop-release.yml`
的 checks job 原文为准；`verify:pre-push` 用显式基线 `ZCODE_PRE_PUSH_BASE` / `ZCODE_AFFECTED_TEST_BASE=origin/main`
跑——**不需要 `--no-verify`**。

| 门禁 | 结果 |
| --- | --- |
| CI checks job 本地原样跑（19 步，含安装/准备 2 步，共 406s） | 19/19 通过；typecheck 先清 18 个 `*.tsbuildinfo` 从头编译 131s |
| `verify:pre-push`（7 项，基线 origin/main，36s） | 7/7 exit 0。第 7 项 `test:unit:affected` **是跳过不是通过**：Vitest 官方选中整个根套件（2156/2156）时脚本按约定跳过并 exit 0 |
| 根单测全量（`--project unit`，与 main 对照，401s） | main `f6dda23d` 79 失败 / 20011 通过（20098，41 个失败文件）；集成分支 77 失败 / 20132 通过（20217，35 个失败文件）→ **集成独有失败 0**（失败集合 ⊆ main 的 79 例），另有 2 例 main 上红、集成侧绿（`createLocalServices` 的旧 Model Preset 刷新、CLI 显式 seed 数据库） |
| `architecture:check --changed`（基线 origin/main） | 0 违规（191 条全部按仓库方式消解，见下） |
| `pnpm lint` | 0 error / 351 warning（与改动前一致；其中 15 条是 design 分支按字节保真取来的上游脚本） |
| `pnpm architecture:check`（全量）/ `test:architecture` / `db:schema:check` | 0 违规 / 43 例全过 / 通过 |
| `pnpm fmt:check` | **存量不合规**（本轮之前就存在），新增内容沿用各文件既有写法 |

**那 191 条 `unmanaged-new-file` 怎么消的**（以后再追上游照这个做）：

- **原样上游 → 写进 upstream snapshot**（`scripts/architecture/upstream-snapshot.json`，按「路径 → 模式 blob」
  指纹准入；判定要求暂存区与工作区同时匹配）。新准入 180 个路径；另有 7 个文件首行的
  `oxlint-disable max-lines` 是移植时加的上游没有的注释，改成 `.oxlintrc.json` 的精确路径行数边界——
  本仓对上游存量大文件的既定做法就是这种精确路径豁免（见该文件 overrides 首段注释），改走配置后
  这些文件与上游逐字节一致，以后叠增量不必再三方合并。
- **对账**：34 条指纹停在上游旧版本（路径本身仍是原样上游），更新为当前内容；本地改过的、已删除的
  只报告不动。这份清单没有仓库自带的更新工具，用的是 `upstream-sync-tools/upstream-snapshot-admit.mjs`
  与 `upstream-snapshot-reconcile.mjs`（只接纳与指定上游 ref 逐字节一致的条目）。
- **确实改过的 10 个文件 → 5 条路径精确例外**（`architecture-policy.yaml`，理由按实测写）：
  `cli-session-control/module.ts`（只删了上游一行未使用的 import）、`useBrowserDesignMode.ts`
  （两处接缝：本仓没有 `ElementMentionSyncPlugin`、`useConfirmDialog` 没有 AbortSignal 参数）、
  受管 worktree 三个 Hook（上游版用必需的 `useServices` / `useIndexedTaskMeta`，本仓 SessionPane/Shell
  的单测渲染壳没有这两层 Provider，实测 42 个相关文件里 11 个 208 例直接抛错；改为可选注入后
  同一组 625 例全过）、`MarketingTouchProvider.tsx`（保留 UWork 的 `toZhOrEnLocale` 中英收窄）、
  ToolSearch 四个文件（见新增缺口 5）。
- **没有为了过门禁去登记上游那 14 个模块**：试过一次，会新增 36 条违规（31 条 `missing-module-artifact`、
  5 条 `disable-count`），正式纳管（补 `module.ts` / `contract.ts` / `contract.example.ts` /
  `contract.test.ts` / `CONTRACT.md`）另起一轮。
- 提交：`7c04add1`（两个停在 3.16.2 口径的旧测试）、`3853eece`（快照准入、对账、例外与 lint 配置）。

**对上一版结论的更正**（文档前面几节写于 Node 25 时期，结论按本节为准）：

1. 「全量对照无集成引入失败」**不成立**：Node 24 净化环境重跑后发现 5 例集成独有失败，全部是停在
   3.16.2 口径的旧测试（`zcodeProtocolV4Command` 的 CAS 表、`zcodeProtocolV4DisplayTolerance` 的夹具键），
   已修（`7c04add1`）。前面那节的「集成 67 文件 256 例、基线 71 文件 256 例」是 Node 25 的数字，失效。
2. 「`pre-push` 因缺 `origin/staging` 只能 `--no-verify`」**不成立**：带显式基线就能过。但要注意
   affected 选中整套时的跳过语义——推之前想要全量证据，仍要显式跑一次全量单测（或依赖 CI）。
3. 「既有红」在 Node 24 下不一样：`projectSidebar*` 那 11 例（`storage?.getItem`）等是 Node 25 的
   环境问题；Node 24 下 main 基线的真实红是 79 例（provider 迁移与模型注册表、桌面环境相关为主），
   集成侧必须逐条落在其中。脚本 `upstream-sync-tools/full-unit-run.sh` 与 `verify-all.sh` 可复现。
4. checks job 实际是 **19 步**（`ci-checks-local.sh` 与 workflow 同步维护），
   `docs/testing/pre-push-hook.md` 里列的步骤清单已过时。

**新增缺口**（与前面 1–4 并列）：

5. **ToolSearch 公告重做未移植**：上游 3.18.1 / 4.0.0 把公告改成按删除原因分段 + MCP 状态公告
   （`description.ts`、`mcp-diagnostics.ts`、`exposure.ts`、`history.ts`、`deferred-call.ts`、
   contracts 的 `tool-search.ts` 等，约 820 行）。本仓这 4 个文件仍是 3.16.2 实现，只随 standalone CLI
   装配补了 local 模式换名 `LocalToolSearch` 的最小改动（已写进路径例外）。
6. **队列冻结编辑（Composer 编辑态）未移植**：契约（4.0.0 的 `command.ts`）已有
   `lockQueueItemEdit` / `releaseQueueItemEdit` 与 `editQueueItem` 的 `editorId`/附件/设置字段，
   但 CLI 侧 `commands/handlers/queue.ts` 还是 3.16.2 版：没有编辑锁，`executor.supports()` 对这两个
   新命令返回 false；`editQueueItem` 因此**既不在 CAS 集、也没有编辑锁**（上游去掉 CAS 的前提是锁）。
   影响面在兼容调用方——第一方桌面/Web/手机已不发 `editQueueItem`（改用
   `deleteQueueItem(baseRevision)` + composer 恢复，见 `docs/conversation-protocol-declaration.md`）。
7. **营销投放的 `localeResolved` 冷启动门槛未取**：上游 3.18.1 起等 `IntlProvider` 读完 setting.json
   再创建 runtime（否则冷启动首发 `marketing/touch` 的 `X-Client-Language` 可能带占位语言）；
   本仓 `useZCodeIntl()` 不暴露 `localeResolved`，保留 UWork 的 `toZhOrEnLocale` 收窄（已写进路径例外）。
8. **文档漂移**：`docs/conversation-protocol-declaration.md`、`docs/zcode-protocol.md` 等仍是上游旧版
   （本轮只在 `zcode-protocol.md` 补了「`editQueueItem` 不要求 `baseRevision`」一句，其余在按特性
   移植时再收）；`docs/ui/composer-edit-mode.md` 未移植。
