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
- `pre-push` 因缺 `origin/staging` 坏掉 → 用 `--no-verify` 并在 PR 正文说明；
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
