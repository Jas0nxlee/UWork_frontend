# GitLab Release 手动附件工具

2026-10-24 已按要求移除 GitLab 同步 workflow 及桌面发布中的派发入口。GitHub Release 不再自动同步到 GitLab，现有远端 Release 和包继续保留。自动分发现在使用[微盘同步](wecom-release-sync.md)。

仓库保留 `scripts/sync-gitlab-release.mjs` 及其客户端、元数据工具和回归测试，供显式人工调用。手动工具仍只选择 macOS ARM64 DMG、Windows x64 EXE、Linux amd64 DEB，验证大小及 SHA-256，将附件上传至 Generic Package Registry，发布标签仅引用独立元数据根提交。调用方负责下载同一选择器返回的附件并串行执行，不提供 GitHub Actions 触发入口。

手动工具读取 `GITLAB_TOKEN`、`RELEASE_TAG`、`RELEASE_JSON`、`ASSET_DIR`，可使用 `GITLAB_BASE_URL`、`GITLAB_PROJECT_PATH`、`GITLAB_PUSH_URL` 指定目标；`INSPECT_ONLY=true` 为只读检查。不要在命令、日志或仓库中保存真实凭据。既有源码迁移功能仅在显式 `CLEANUP_SOURCE` 下运行，默认关闭；本次停用不执行迁移或远端清理。

完整合同见[手动工具 spec](../specs/gitlab-release-sync.md)。回归命令：

```sh
node --test scripts/test/gitlab-release-*.test.mjs
```
