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
