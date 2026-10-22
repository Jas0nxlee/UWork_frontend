# GitHub Release 同步到 GitLab

`.github/workflows/gitlab-release-sync.yml` 在 GitHub 发布 Release 后，把同一个版本同步到
`http://g.ucas.com.cn:8088/lijingping/uwork`。规则与验收场景见
[specs/gitlab-release-sync.md](../specs/gitlab-release-sync.md)。

## 同步内容

| 内容           | 说明                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| Git 标签       | 推送 Release 对应的标签；GitLab 已有同名标签且指向其它提交时失败，不移动标签          |
| 分支           | 把 Release 提交快进推送到 `main`；默认不允许覆盖 GitLab 上的分叉历史                  |
| GitLab Release | 标题与说明取自 GitHub Release，已存在时更新                                           |
| 资产链接       | 默认链接到 GitHub Release 的下载地址；开启 `upload_assets` 后改为 GitLab 包注册表地址 |

同步不会删除 GitLab 上已有的分支、标签、Release 或其它资产链接。

## 一次性配置

1. 在 GitLab 创建访问令牌（项目级 Project Access Token 或个人 Access Token）：
   - scopes：`api`、`write_repository`；
   - 角色：至少 Developer；若 `main` 是保护分支，需要 Maintainer 或把该用户加入允许推送列表。
2. 在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加 secret `GITLAB_TOKEN`。
3. 可选变量（`Settings → Secrets and variables → Actions → Variables`）：

| 变量                       | 默认值                      | 用途                                                                                    |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `GITLAB_BASE_URL`          | `http://g.ucas.com.cn:8088` | GitLab 地址                                                                             |
| `GITLAB_PROJECT_PATH`      | `lijingping/uwork`          | 目标项目路径                                                                            |
| `GITLAB_PUSH_URL`          | 由地址和项目路径推导        | 推送 URL 覆盖，通常不需要                                                               |
| `GITLAB_SYNC_BRANCH`       | `main`                      | 同步到的分支                                                                            |
| `GITLAB_SYNC_ASSETS`       | `false`                     | 是否把安装包等资产上传到 GitLab 包注册表                                                |
| `GITLAB_SYNC_FORCE_BRANCH` | `false`                     | 是否用 `--force-with-lease` 覆盖分支                                                    |
| `GITLAB_SYNC_RUNNER`       | `ubuntu-24.04`              | 托管 runner 无法访问校内地址时指定自托管 runner 标签；runner 需能运行 Node、git 与 `gh` |

4. 工作流文件必须存在于默认分支上；`release` 事件只会加载默认分支的工作流。

## 触发方式

- `release: published`：手工在 GitHub 上公开 Release 时自动运行。
- `workflow_dispatch`：手工重跑。不填 tag 时取最新已发布 Release；可勾选 `upload_assets`、`force_branch`。
- 发布流水线派发：`desktop-release.yml` 的 `publish` job 在公开 Release 后调用
  `gh workflow run gitlab-release-sync.yml`。原因是 GitHub 会抑制由 `GITHUB_TOKEN`
  创建 Release 所触发的 `release` 事件，只有 `workflow_dispatch` 等少数事件例外。

## 资产上传

`GITLAB_SYNC_ASSETS=true`（或手工派发时勾选 `upload_assets`）会先用
`gh release download` 下载本次 Release 的全部资产，逐个与 GitHub 元数据比对大小，再上传到
GitLab Generic Package Registry：

- 包名：`uwork-release`；版本：标签去掉前导 `v`；
- Release 链接指向 GitLab 包地址，并附带 `/-/releases/<tag>/downloads/binaries/<文件名>` 直链；
- 安装包体积较大（单版本可达数 GB），上传耗时随带宽增长，工作流超时上限为 120 分钟；
- GitLab 项目是私有的，包文件下载需要登录或令牌。

## 排查

| 现象                                   | 处理                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `缺少 GITLAB_TOKEN secret`             | 按上文创建 token 并添加 secret                                                                                                             |
| `无法连接 GitLab ...`                  | runner 访问不到目标地址。校内 DNS 解析为 `10.1.180.113`，托管 runner 走公网解析；公网入口不可用时用 `GITLAB_SYNC_RUNNER` 指定自托管 runner |
| `GitLab 已存在指向其它提交的标签`      | 标签不可变。确认版本号后发布新版本，或人工删除 GitLab 上的错误标签再重跑                                                                   |
| `无法快进到 ...；...勾选 force_branch` | GitLab 分支有本地提交。确认可以覆盖后手工派发并勾选 `force_branch`，或先人工合并                                                           |
| `GitLab API ... 返回 401/403`          | token 缺少 `api` / `write_repository`，或角色权限不足                                                                                      |
| `Release ... 仍是草稿`                 | 先公开 GitHub Release 再同步                                                                                                               |

脚本可以直接在本地或 runner 上重放，便于排查：

```bash
gh api repos/Jas0nxlee/UWork_frontend/releases/tags/v0.10.0 > /tmp/release.json
GITLAB_TOKEN=... RELEASE_TAG=v0.10.0 \
  RELEASE_JSON=/tmp/release.json \
  node scripts/sync-gitlab-release.mjs
```

令牌只通过环境变量进入脚本；Git 推送使用临时凭据文件，日志与命令行参数不包含令牌。
