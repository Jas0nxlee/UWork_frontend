# 0.1.3 会话库升级发布审查

0.1.3 发布候选在公开前取消，未分发安装包；后续 Windows 平台 home 兼容补丁随 0.1.4 发布，原标签保留审计。

基于当前主线 `744c49da` 整合此次修复。原始工作区的其他改动保留，发布候选在独立 worktree 中构建。

## 审查结果

独立审查发现并修复以下发布阻断或兼容缺口，全部保留先失败后通过的回归：

- 默认库和项目显式库混用：CLI 复用配置 owner 的真实路由，只排除确实属于其他库的条目；默认路径缺失历史仍拒绝。相同源库的符号链接/硬链接别名仍校验归属。
- 所有项目均使用显式库：Host 仍先准备 managed fallback，避免后续全局新任务被未完成默认迁移拒绝。
- Windows 原生 `zcode-agent.exe app-server` 旧写者不再被漏识别。
- Linux 通过 proc FD 的 bigint device/inode 识别硬链接写者，权限或身份未知时中止。
- 扫描内部文件 ENOENT 不再将整个目录当作空清单；只有确认顶层根确实缺席才跳过，不绕过写者门禁。
- 保留当前主线的本地开发版名称与既有 Chromium 目录规则，冷启动和业务 Main 使用一致身份。

## 已完成验证

- CLI：7 文件、116 项通过；Host fallback：2 项通过。
- Desktop/Services/UI 重点回归：16 文件、100 项通过；额外路径与 fallback：6 项通过；整根复制 Node fixtures：19 项通过。
- GitLab 手动附件、打包与发布契约：45 项通过。依赖审计 high/critical 均为 0。
- macOS ARM64 正式配置包成功生成，未改写 ASAR、未开启 Node Inspector；打包态升级脚本实际通过。

正式包用例先创建真正的 Host/CLI 存储，再按冻结的 v0.1.2 schema 校验并构造隔离升级前状态。App 从仓库外 cwd 启动，测试不注入迁移开关，避免误测源码 CLI 或由测试授予迁移资格。断言包括：普通/归档两会话导入、可见正文、foreign 与显式项目库隔离、旧 main/WAL 哈希不变、彻底退出后重启、新目标数据和完成账本保持。

本地日志：`/tmp/uwork-release-packaged-upgrade-mac-final.log`。截图保存在本地 `.e2e-artifacts/packaged-upgrade-mac-arm64-1793165114044/`。这些临时制品不随源码提交；正式发布流水线对五个平台运行相同门禁，并保留 `packaged-upgrade-*` CI 证据附件。此记录中的本地通过不冒充尚未完成的远端五平台结果。

## 分发与回退边界

版本说明以 `docs/releases/0.1.3.md` 为准。GitHub 是现有源码与构建仓库，GitLab 采用仓库保留的手动附件工具，仅分发 mac ARM DMG、Windows x64 EXE、Linux amd64 DEB，并校验远端大小和 SHA-256；不恢复已移除的 GitLab 自动同步，不向 GitLab 推送源码历史。

迁移保留旧库，失败不以空库替代。升级后的新数据不会自动回写旧版本；不要把保留旧库误解为无损降级承诺。未操作开发者真实会话库，所有验收使用自己的临时目录。
