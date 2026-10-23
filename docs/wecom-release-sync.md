# Release 安装包自动同步企业微信微盘

此 workflow 将公开的 GitHub Release 的三个安装包归档到指定微盘文件夹的版本子目录，例如 `UWork/v0.1.2/`：

- `UWork-0.1.2-mac-arm64.dmg`
- `UWork-0.1.2-win-x64.exe`
- `UWork-0.1.2-linux-amd64.deb`

复用 GitLab 的安装包选择与 SHA-256 校验，不上传 ZIP、其它架构或辅助附件。

## 一次性配置

在仓库 Settings → Secrets and variables → Actions 配置下表。不要将真实凭据写入仓库、issue 或日志。

| 位置               | 名称                 | 用途                                                                                                  |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------- |
| Secret             | `WECOM_CORP_ID`      | 企业标识，须与应用所属企业一致                                                                        |
| Secret             | `WECOM_SECRET`       | 已被允许调用微盘接口的企业自建应用 Secret                                                             |
| Variable 或 Secret | `WECOM_SPACE_ID`     | 目标共享空间标识                                                                                      |
| Variable 或 Secret | `WECOM_FOLDER_ID`    | 目标父文件夹标识；不设置时使用空间根目录                                                              |
| Variable 或 Secret | `WECOM_SYNC_ENABLED` | 填 `true` 后开启自动派发及 published 事件同步；手动补传不受此开关限制                                 |
| Variable           | `WECOM_SYNC_RUNNER`  | 可选 runner 标签，默认 `ubuntu-24.04`；可信 IP 限制场景使用有固定出口的 Linux self-hosted runner 标签 |

企业管理员需在「协作 → 微盘 → API」配置「可调用接口的应用」，并确认该应用可以访问目标空间、列出目录、创建版本文件夹与上传文件。普通成员可访问的分享链接不能代替服务端 API 的空间/目录参数；目标现有共享文件夹能否被应用操作，必须用实际应用权限验证。此流程不创建空间、不调整空间成员权限。

目录和开关已放在 Secrets 时无需迁移。同名 Variable 非空时优先，只有 Variable 为空时才读取 Secret；两处同时设置时应保持一致。开关通过步骤环境读取，不输出原值。

如果应用安全配置要求可信 IP，需允许所选 runner 的出口地址；GitHub 托管 runner 的出口可能变化，适合改用固定出口 runner。实际应用权限和 IP 错误会使同步失败，不会切换到个人身份或其它目录。

先配置凭据与目标目录，完成一次手动上传核验后再将 `WECOM_SYNC_ENABLED` 设置为 `true`。没有开关时桌面发布仍可完成，自动同步不执行；手动运行时缺少配置会直接列出缺少的配置名并失败。

## 自动触发与手动补传

### 使用固定代理出口

也可以保留 GitHub 托管 Linux runner，通过 `WECOM_PROXY_CONFIG` Secret 配置一个 VLESS Reality 节点。值为单个节点的 JSON 对象（包含 server、port、uuid、flow、tls、servername、reality-opts、client-fingerprint、network、encryption 等字段），不是整份 Clash 配置。必须开启 TLS 且 `skip-cert-verify` 为 `false`；只支持 TCP、Vision 和 chrome 指纹。

代理只解决出口固定问题，实际出口地址仍需添加到企业微信应用的“企业可信 IP”。工作流先运行无凭据出口/连通性探测，通过后才下载三个安装包；上传时重新启动代理，所有企微 token、目录及文件请求都经该出口。GitHub 附件下载不使用该隧道。代理连接失败时停止，不回退直连。

代理二进制固定为 Mihomo `v1.19.33`，下载后核对仓库代码中的固定 SHA-256。配置仅在运行时随机临时目录中创建（目录 0700、文件 0600），只监听 loopback；成功、失败或取消时删除配置并终止代理。原始节点配置和代理日志不保存到 artifact。

### 一次性初始化应用空间

普通成员共享空间出现空间级拒绝时，已获得明确授权后可以手动选择 `bootstrap_space=true`，创建由当前应用拥有的「UWork 发布包」空间。须先配置 Secret `WECOM_SPACE_ADMIN_NAME`（唯一管理员的准确姓名），并在 `bootstrap_public_key` 输入本地 RSA 公钥 PEM 的 Base64。私钥仅留在调用方本地，至少使用 2048 位 RSA。

初始化先查询可见通讯录并校验唯一成员及激活状态，以权限 7 将该成员设置为管理员；不删除、转让或更改原空间，也不下载安装包。创建后立即保存 `wecom-encrypted-target-<运行编号>` artifact（1 天、RSA-OAEP-SHA256 加密），随后校验管理员和目录。管理员缺失或创建响应不明时停止，不盲目重新创建。已切换到该专用空间后，再次初始化会验证并复用，不重复创建。

只有初始化验证成功后，调用方解密交接配置，将 `space`、`folder` 分别写入 `WECOM_SPACE_ID`、`WECOM_FOLDER_ID`，再以普通模式运行同步。不要在输出、工单或仓库中保存明文账号、空间标识、私钥。`bootstrap_space` 和 `inspect_only` 不能同时开启；自动 Release 不执行初始化。

### 触发方式

需要定位空间权限时，可以勾选 `inspect_only`，或运行 `gh workflow run wecom-release-sync.yml --ref main -f tag=v0.1.2 -f inspect_only=true`。该模式通过同一代理和凭据读取应用名称、空间信息和一条目录列表；不下载安装包、不上传、不调整权限。报告中只有名称、结果码和格式判断，不输出内部标识或凭据。诊断拒绝仍失败退出，不能被当作同步成功。

- 桌面发布工作流将所有附件上传并将 Release 公开后，显式派发微盘同步。`GITHUB_TOKEN` 发布事件不会再自动启动另一个 workflow，因此不能只依赖 `release.published`。网页人工发布 Release 时也支持 published 事件。
- 在 Actions → **Sync release to WeCom Drive** → Run workflow，选择已包含该 workflow 的默认分支，输入已公开标签，如 `v0.1.2`。不填时使用最新公开 Release。草稿、非正式版本和缺少必需安装包会失败。
- 也可用 CLI：`gh workflow run wecom-release-sync.yml --ref main -f tag=v0.1.2`。查看运行结果：`gh run list --workflow wecom-release-sync.yml`。
- 失败后可以在 GitHub Actions 重新运行失败 job，或再次按标签手动补传。已完成且内容一致的文件跳过；只上传缺失安装包。不会删除或覆盖已有文件。

## 重试、核验与报告

下载元数据、下载每个附件最多尝试 4 次。企微只读和分块请求遇到临时网络问题、超时、HTTP 429/5xx、系统忙/限频最多尝试 4 次，退避 1/2/4 秒；请求超时 60 秒。token 提前刷新，明确失效时额外刷新一次。目录创建、上传初始化及完成提交遇到响应丢失，先回读目标核验，不盲目重发；无法确定结果时失败，可再次补传。

上传前验证三个文件的 GitHub SHA-256 和大小；分块采用官方 2 MiB 累积 SHA 合同。每个文件上传后核对名称、目录、状态、大小和完整 SHA-1；最终再次分页查重和回读。任一冲突、缺包或校验错误阻止成功状态，已完成的安装包保留。

执行时最多并行一个微盘同步 job，不能取消正在执行的版本。请勿让其它自动化同时写入同一发布目录。workflow 失败不会撤回 GitHub Release 或已分发的 GitLab 安装包。

上传脚本启动后始终保存 `wecom-release-verification-<运行编号>` artifact（7 天），包含成功进度和总状态，不含凭据、上传凭证或内部目录标识。配置检查或 GitHub 下载阶段失败时，上传脚本尚未启动，不生成该报告，查看对应步骤日志。

## 本地回归

```sh
node --test scripts/test/wecom-release-*.test.mjs scripts/test/gitlab-release-*.test.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

本地替身测试验证重试、去重、分页、部分失败与协议；真实上传需要企业配置后的手动验收。

依据：[普通上传 API](https://developer.work.weixin.qq.com/document/path/97880)、[分块上传 API](https://developer.work.weixin.qq.com/document/path/98004)、[官方摘要 demo](https://github.com/wecomopen/file_block_digest/tree/main/demo)。设计与验收合同见 [spec](../specs/wecom-release-sync.md)。
