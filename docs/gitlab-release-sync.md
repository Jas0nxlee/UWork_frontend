# GitHub Release 同步到 GitLab

工作流见 `.github/workflows/gitlab-release-sync.yml`，完整产品规则与验收见 [同步 spec](../specs/gitlab-release-sync.md)。

## 当前同步内容

GitLab 只分发当前版本三个安装文件：

- `UWork-<version>-mac-arm64.dmg`：macOS Apple Silicon。
- `UWork-<version>-win-x64.exe`：Windows x64。
- `UWork-<version>-linux-amd64.deb`：Linux / Ubuntu x64。

工作流通过 `selectGitLabReleaseAssets` 精确选择并下载，脚本用同一名单校验、上传和创建下载链接。缺失或重复任一目标、大小或 SHA-256 不一致时失败，不回退到 ZIP。GitLab 的文件链接全部指向 Generic Package Registry；保留 GitHub Release 来源页面链接。GitHub 自身继续发布全部五平台产物、安装格式、审计和摘要。

不推送应用源码、源码标签或源码分支。GitLab 发布标签引用单 README、无父提交的独立 `release-metadata` 根提交。正常同步不删除历史发布和人工链接，不移动已有标签。一次性源码清理仅保留显式 `cleanup_source` 迁移入口，自动发布关闭。

## 配置和触发

- GitHub Actions secret：`GITLAB_TOKEN`，需具备 `api` 与创建独立元数据引用所需的 `write_repository` 权限。
- 仓库变量：`GITLAB_BASE_URL`、`GITLAB_PROJECT_PATH`、可选的 `GITLAB_PUSH_URL` 和 `GITLAB_SYNC_RUNNER`；默认目标以脚本为准。
- 手工公开 Release 通过 `release: published` 触发；发布流水线公开 Release 后显式派发，避免 `GITHUB_TOKEN` 不触发后续事件。
- 可手工派发并指定 tag 重跑；`inspect_only` 为只读检查。工作流不再提供 `upload_assets`、`force_branch` 或源码分支选项。
- 所有版本共用项目级 concurrency，避免元数据根初始化和附件同步竞态。失败时按同一 tag 重跑，已匹配的包文件和链接幂等跳过。

## 验证

`node --test scripts/test/gitlab-release-*.test.mjs` 验证三个安装文件的选择、缺失/重复拒绝、包校验、链接分页和源码隔离。运行报告保留前后引用及实际上传文件清单。
