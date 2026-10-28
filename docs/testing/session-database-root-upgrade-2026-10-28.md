# 会话库路径升级与冷迁移验收（2026-10-28）

本报告记录初次源码及隔离 macOS 桌面验收阶段；当时尚未提交、发布或安装 Release。后续主线整合、发布审查与正式配置包验收见 [0.1.3 审查记录](session-database-release-0.1.3-review.md)。产品合同及状态所有者、事件顺序见 [spec](../../specs/session-database-root-upgrade.md)。本轮没有迁移开发者真实会话库。

## 最终行为

- 本地 Desktop 首次启动自动迁移旧默认会话库中可确认属于 UWork 的历史；显式自定义路径与 standalone CLI / Source Server 不被重定向。
- SQLite backup 包含已提交 WAL；源库保留。目标冲突、归属不明、活跃写者等进入错误 gate，不建立空库绕过。迁移账本支持恢复与幂等重启。
- 设置中移动整个数据目录只记录 pending；运行中仍使用当前根。下次启动停写后复制、校验并提交；失败可重试，经 owner 确认未提交后可取消并使用原根。
- Main、Host、Scheduler、CLI 使用同一已提交活动根；原会话 cwd/identity 和项目文件不变。移动整个根不改写 CLI 私有完成账本。
- 调用轨迹读取有效 CLI 根；窄窗标题/统计可换行，搜索可定位未挂载的虚拟列表行。

## 桌面与截图证据

| 场景                                                                                     | 最终结果                                                                                          | 报告                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| CDD01：保存 pending 后继续对话，冷重启到新根，再续聊                                     | 1/1 PASS；原库不再增加会话消息，目标库继续写入，项目 canary 不变；显式确认登录/职业引导弹层已退出 | [报告](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261028045602804-p14831-dfc1e5904a6c79e1/summary.md) |
| DBROOT-01/02：隔离旧目录布局自动升级、原上下文续聊、新任务新库、幂等重启、目标冲突后取消 | PASS；旧库行保持不变，foreign 目标文件保留，取消后原历史仍可读                                    | [报告](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261028045412236-p12017-9759934ff5e1b8f8/summary.md) |
| 调用轨迹：真实任务入口、内容/工具展示、delta、虚拟列表搜索、窄窗                         | PASS；与 DBROOT 同轮 2/2 PASS                                                                     | [报告](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261028045412236-p12017-9759934ff5e1b8f8/summary.md) |

已逐张检查最终截图：[迁移后续聊](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261028045602804-p14831-dfc1e5904a6c79e1/data-directory-cold-move-resumed.png)、[窄窗轨迹搜索](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261028045412236-p12017-9759934ff5e1b8f8/screenshots/trajectory-narrow-search.png)、[冲突提示与取消入口](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261028045412236-p12017-9759934ff5e1b8f8/session-db-cold-migration-conflict.png)、[取消后原历史](../../packages/desktop/.e2e-artifacts/desktop-e2e-20261028045412236-p12017-9759934ff5e1b8f8/session-db-cold-migration-cancelled.png)。登录弹层仍覆盖界面的早期 CDD01 截图不作为 UI 通过证据，最终用例已增加真实处理与反向断言。

DBROOT 候选仍保留 `manual-review/pending`，没有自动晋级。旧目录布局由真实 CLI 生成历史后在隔离目录构造，不等同于旧正式安装包升级。

## 实际发现并修复的边界

1. Worker 不 chdir，配置必须显式传 workspace cwd；否则项目自定义库可能被误判为默认库。对应回归先失败后通过。
2. 过期 cancel 不得污染下一次 retry；取消使用独立 admission，不能放宽普通 retry 对损坏库等错误的限制。同请求重试刷新恢复原文，避免取消时丢失失败期间的新设置。
3. 冷迁移后的首次业务导入发生在 ready 后，`@arms/rum-electron` 模块顶层 privileged scheme 注册会抛错。提前只加载 SDK 模块，并在最终注册集合保留 media/plugin/rum；telemetry init 与业务库仍在迁移后。无 WebDriver/inspector 的真实 Electron 红态 code 1，绿态主窗创建、DOM 就绪并持续运行 25 秒后主动清理；该 smoke 未注入业务 provider fixture，不替代上面的完整桌面用例。
4. 辅助空白页或更新页 ready 不能触发冷窗交接；测试通过 fresh window handle 与业务 DOM 重建 bridge。冷页不调用尚未注册的业务追踪 handler。
5. TypeScript Host 声明缓存与打包 out 分离，只生成声明，避免构建清理导致 TS6305 或类型检查覆盖已打包 JS。

## 检查范围

使用仓库固定 Node 24.14.0 / pnpm 10.33.2；未运行未授权的全量单测。

- CLI 迁移引擎及 stdio/config cwd 回归：5 文件、49 项通过。
- 最终冷启动、控制 admission、设置 owner、刷新与环境变量组合：13 文件、88 项通过。
- 整根复制 Node fixtures：19/19；路径 fixtures：4/4，通过。其他 Host/shared、轨迹 UI 和配置专项分别通过，不将重叠集合相加为唯一总数。
- `pnpm typecheck`、`pnpm lint`（331 warnings，0 errors）、`pnpm architecture:check --changed`（0 violations）、`git diff --check` 通过。
- Desktop `build:no-runtime-assets` 通过；构建后再次 `pnpm typecheck` 通过。CLI Desktop Agent 在前序完整 E2E 构建中成功生成，后续桌面复测复用同一 Agent。

Windows/Linux 的 writer inventory 使用定向测试，不代表两平台桌面实机升级验收；尚未打包发布、同步 GitLab Release 或验证实际下载升级。
