# 官方插件模型继承修复验证（2026-10-23）

## 结果

扫描 `OFFICIAL_PLUGIN_DEFINITIONS` 中全部 15 个内置官方插件。当前仅 documents、pdf、
presentations、spreadsheets 四个插件提供 agent Markdown，均为 `visual-judge`。
已移除四份定义中的账号模型和推理档位。新增回归从正式插件清单遍历 agent，并通过正式 loader
确认没有固定模型，防止未来新增官方 agent 再引入账号绑定。

设置页提供“继承主任务模型”和“使用插件默认”两个动作。前者以 `null` 保存显式继承，
后者删除用户覆盖。设置列表、Host runtime schema、独立 CLI loader 和规范名/别名保持一致；
用户已保存的具体模型覆盖继续保留。规则、时序和接口见
[规格](../../specs/official-plugin-subagent-model-defaults.md)。

## 已执行验证

使用仓库要求的 Node 24.14.0 和 pnpm 10.33.2。

| 检查 | 结果 |
| --- | --- |
| workspace freshness | 通过 |
| 根 UI、service、shared、runtime config、watcher 6 个聚焦文件 | 143 通过，1 个原有文件系统条件用例跳过 |
| 最终 UI、service、shared 回归（包含 service → Host snapshot null 往返） | 92 通过 |
| CLI loader、runtime config、官方缓存韧性、子任务选择/执行/刷新 7 个聚焦文件 | 68 通过 |
| 完善官方清单/实际 loader 扫描后的 bootstrap 文件 | 12 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm --dir apps/zcode-cli typecheck` | 32 个任务通过 |
| `pnpm lint` | 0 错误，331 个现有警告 |
| `pnpm --dir apps/zcode-cli lint` | 0 错误，54 个现有警告 |
| `pnpm architecture:check --changed` | 0 违规 |
| 修改文件格式与 `git diff --check` | 通过 |
| Desktop SE-04，当前源码构建的 Electron | 1 通过 |

新增测试曾在修复前复现：共享 reader 丢弃 `null`、服务恢复插件固定模型、前端误报继承。
修复后这些断言通过。架构策略只为已存在的共享 runtime schema 文件登记了精确路径准入，
没有调整测试阈值、依赖规则或全局 baseline。

## 桌面证据

运行 ID：`desktop-e2e-20261023-075503-010`。

SE-04 实际点击模型/档位控件，验证：保存具体模型 → 继承主任务并保存 `null` →
离开并重新进入设置后仍回显继承、无独立档位 → 恢复插件默认并删除覆盖。
整个流程校验插件 Markdown 内容未被改写。

本场景准备改用产品提供的“跳过登录”按钮、Escape 退出初次引导，并只初始化设置需要的
Provider Registry；不进行真实企业微信登录，不依赖办公模式隐藏的 Composer 模型控件。
初次失败运行的引导和登录遮挡均保留在本地 E2E artifacts 中，最终运行通过。

## 全量 CLI 检查限制

`pnpm --dir apps/zcode-cli test` 未通过：TUI 两个现有品牌/颜色断言失败后 Turbo 终止其他任务；
core context-builder 的身份文案测试也出现 ZCode/UWork 预期差异。
在 `git archive HEAD` 的隔离源码副本中重跑，TUI 同两条失败；context-builder 为 9 失败、35 通过。
这些源文件和断言不在本次修改中，没有修改或跳过它们来使全量结果变绿。

本次交付为源码修复、当前源码开发构建和 macOS 桌面验证。未发布安装包，
已安装客户端及其旧插件缓存的更新需随新的客户端构建交付；未声称 Windows/Linux 安装包验收。
