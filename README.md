<div align="center">
  <img src="packages/desktop/build/uwork.svg" alt="UWork" width="96" height="96" />
  <h1>UWork</h1>
  <p>连接自己的模型服务，在同一个工作区中完成代码开发、文档处理与日常任务。</p>
  <p>简体中文 · <a href="README.en.md">English</a></p>
  <p><a href="https://github.com/Jas0nxlee/UWork_frontend">源码</a> · <a href="https://github.com/Jas0nxlee/UWork_frontend/releases">下载安装</a> · <a href="LICENSE">Apache-2.0</a></p>
</div>

UWork 是面向企业与个人开发者的 AI 工作台。它提供 UCAS 与自定义模型服务、办公 / 编程模式、可选企业微信身份与网关用量统计，并在同一个工作区中处理代码、文档和日常任务。

客户端登录页底部显示当前构建版本。源码版本见 [package.json](package.json)，已发布安装包及其对应版本见 [GitHub Releases](https://github.com/Jas0nxlee/UWork_frontend/releases)。

## 当前功能

第一次使用 UWork 写代码？先阅读 [代码开发使用手册](docs/user-guide/README.md)，了解办公 / 编程模式、企业微信登录、项目开发、检查验证与进度保存；也可以打开 [离线图文版](docs/user-guide/index.html)。

| 功能             | 说明                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| UCAS 默认供应商  | 首次启动预置六个模型，名称、连接地址和 Chat Completions 格式固定；可编辑 API Key、模型参数与启停状态，并自动获取模型。     |
| 自定义模型服务   | 解锁添加入口后，可配置 Base URL、API Key 和 API 格式，支持 Chat Completions、Responses、Anthropic Messages。               |
| 自动获取模型     | 从供应商读取模型 ID，去重后批量添加；已有模型的参数、启停状态和顺序保持不变。                                              |
| 模型参数编辑     | 编辑上下文窗口、输出上限、输入类型及推理选项。                                                                             |
| 办公 / 编程      | 使用同一个按钮切换模式并记住选择；办公模式侧重操作摘要与结果，编程模式显示命令、输出与代码变更详情。                       |
| 企业微信身份     | 桌面登录卡片内扫码，也可以跳过；认证后显示姓名、部门与职位。同一设备各窗口共享企业账号，工作区和未提交草稿仍由各窗口管理。 |
| 企业网关自动配置 | 登录后自动写入 UCAS 网关地址与 API Key、按套餐补齐模型，并在使用统计中展示套餐额度、请求、费用与 Token 用量。              |
| 工作区与任务     | 支持项目、会话、文件、终端、Git，以及插件、MCP、技能和子智能体。                                                           |
| Office 文件      | 预览 Word、Excel 和 PPT，受支持文档可在应用内编辑并保存备份；复杂结构按格式护栏保持只读。                                  |
| 定制界面         | UWork 字标与图标、UCAS 背景、深浅主题，以及登录页底部的客户端版本信息。                                                    |

模式切换只改变界面呈现，不改变工具权限或模型服务权限。安装包可从本仓库 Releases 下载；自动更新是否启用由构建配置决定，默认关闭。

## 配置模型并开始使用

1. 启动桌面应用；如不使用企业身份，点击 **跳过登录，继续使用**。
2. 使用企业微信登录时，客户端会调用企业后台自动写入默认 `ucas` 供应商的网关地址与 API Key，并按当前套餐追加可用模型；没有企业后台或自动配置失败时，打开 **设置 → 模型设置** 手工填写 API Key。
3. 点击 **自动获取**，或通过 **添加模型** 手动输入模型 ID。
4. 按服务商实际能力调整模型参数，再在聊天窗口选择供应商和模型。
5. 企业账号可在 **设置 → 使用统计 → 企业网关** 查看账号、网关地址、套餐额度与用量，并显式同步或替换密钥。

### 使用其他模型供应商

**添加供应商**初始呈灰色。在同一次打开模型设置期间，连续点击该按钮 **20 次**即可解锁，再点击一次打开模板选择器；解锁前点击其他区域会清零计数，离开并重新打开模型设置需重新解锁。这是界面规则，不是权限控制。

选择模板或创建自定义供应商后，填写服务商提供的**完整 API Base URL**、对应 API 格式及 API Key，再获取或添加模型。

以下为虚构地址示例，使用时替换成自己的服务地址：

| API 格式           | Base URL 示例                | 对话请求路径           |
| ------------------ | ---------------------------- | ---------------------- |
| Chat Completions   | `https://api.example.com/v1` | `/v1/chat/completions` |
| Responses          | `https://api.example.com/v1` | `/v1/responses`        |
| Anthropic Messages | `https://api.example.com/v1` | `/v1/messages`         |

模型列表可访问，不代表每个模型都能执行推理或支持工具调用。请以服务商文档、权限与一次实际对话结果为准。

## 可选企业微信登录

桌面启动时，未认证用户可以在登录卡片内扫码，也可以跳过并继续使用。跳过只对当前窗口生效，重启后仍可选择登录；工作区内可通过 UWork 字标下的入口再次打开登录页，认证后点击姓名查看来源或退出。

企业身份用于姓名展示与企业网关接入，不引入账号数据隔离、云同步或额外本地操作权限。已有本地 API Key 不会被自动覆盖，可在「企业网关」面板显式替换。登录或退出不会迁移、认领或删除已有工作区、会话与模型配置。

GitHub 正式安装包已携带默认企业微信公开登录参数，Windows、macOS 和 Linux 安装后可直接扫码，无需复制配置文件。管理员可使用本机配置覆盖默认参数，位置、接口与自动配置规则见 [企业微信登录对接](docs/enterprise-identity-integration.md)。

## Office

- 应用内 Office 功能处理支持的 Word、Excel、PPT 文件，按格式保真范围与大小限制决定可编辑或只读；保存有版本冲突检查及备份，不承诺任意复杂文档完整往返保真。范围见 [Office 预览与编辑](specs/office-editors-triad.md)。
- [office-editor 插件](plugins/office-editor/README.md)提供 Word 修订与批注审阅。默认未配置外部编辑引擎时显示只读预览；完整引擎编辑需要单独配置，复制组件的许可义务见插件文档与第三方清单。

## 数据目录

UWork 使用自己的用户级数据根 `~/.uwork`，配置目录为 `~/.uwork/v2`。首次启动使用空目录，不会导入其他应用的数据。可用 `UWORK_DATA_BASE_DIR` 覆盖数据根，详见 [独立数据根](specs/uwork-data-root-separation.md)。

## 从源码运行

当前本机构建与安装验证以 **macOS Apple Silicon** 为主。仓库仍包含 Windows、Linux、HTTP 服务与独立分享页入口；这些入口不代表已经完成相同范围的发布验收。

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**。工具版本以 [mise.toml](mise.toml) 为准；macOS 编译原生组件还需要 Xcode Command Line Tools。以下命令从仓库根目录执行。

```bash
git clone https://github.com/Jas0nxlee/UWork_frontend.git
cd UWork_frontend
pnpm bootstrap
UWORK_DATA_BASE_DIR="$HOME/.uwork-dev" pnpm dev:desktop:test
```

`bootstrap` 安装依赖、准备本机运行资源并构建相关包。开发命令使用独立数据目录；Windows 需使用对应 shell 的环境变量语法。已安装 mise 时，也可按 [mise.toml](mise.toml) 执行 `mise install`、`mise run bootstrap` 和 `mise run dev`。

| 入口               | 命令                            |
| ------------------ | ------------------------------- |
| 桌面开发           | `pnpm dev:desktop`              |
| 测试环境桌面开发   | `pnpm dev:desktop:test`         |
| HTTP 服务开发      | `pnpm dev:server`               |
| 独立分享页开发     | `pnpm dev:web-share:test`       |
| 准备远程工作区资源 | `pnpm bootstrap:with-remote`    |
| 桌面安装包构建     | `pnpm bundle:desktop -- --help` |

`dev:desktop` 使用 production 服务配置；`dev:desktop:test` 使用 test 配置。环境名不代表应用已经完成签名、公证或发布。

### 构建 macOS 应用

```bash
pnpm bundle:desktop -- --os mac --arch arm64
```

如需本机临时安装自己构建的应用，可使用生成的 `UWork.app`，再按本机安全策略完成签名与验证。临时签名不等同于 Apple 开发者签名或公证。修改应用图标时，编辑 [SVG 源文件](packages/desktop/build/uwork.svg)，然后运行：

```bash
pnpm exec electron packages/desktop/scripts/build-uwork-icons.cjs
```

## HTTP 服务

`pnpm dev:server` 启动 HTTP / WebSocket 服务，默认监听 `3030`。独立分享页通过 `pnpm dev:web-share:test` 开发。远程工作区与分享页属于不同的使用场景，请按各自文档配置。

## 数据与网络边界

- 模型请求会发送到你配置的供应商；插件、远程工作区、诊断等能力也有各自的网络行为。
- 企业微信身份使用独立凭据与设备会话；登录或退出不会迁移、认领或删除已有工作区、会话与模型配置。
- 办公 / 编程是界面模式，不是操作系统沙箱或权限级别。
- 不要在公开仓库中提交 API Key、真实配置、日志或会话数据。

## 开发检查

```bash
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm architecture:check --changed
pnpm verify:pre-push
```

测试入口与环境依赖以目标包的 `package.json` 和实际测试文件为准。上述检查用于验证当前工作树的类型、代码质量、格式和架构约束。

## 源码与设计说明

| 目录                                                 | 职责                                     |
| ---------------------------------------------------- | ---------------------------------------- |
| `packages/desktop`                                   | Electron Main、Host、Renderer 和桌面打包 |
| `packages/ui`                                        | 共享 React 界面、hooks 和状态            |
| `packages/services`                                  | 业务服务与持久化                         |
| `packages/provider`、`packages/provider-node`        | 供应商配置、模型注册与 Node 实现         |
| `packages/server`                                    | HTTP / WebSocket 服务                    |
| `packages/shared`、`packages/rpc`、`packages/client` | 协议、RPC 与客户端                       |

- [自定义供应商与账号入口调整](specs/custom-providers-only.md)
- [模型自动获取与参数编辑](specs/provider-model-discovery.md)
- [UCAS 默认供应商与添加入口规则](specs/ucas-default-provider.md)
- [可选企业身份与跨窗口同步](specs/enterprise-identity.md) · [认证服务对接](docs/enterprise-identity-integration.md)
- [企业网关自动配置、套餐与用量](specs/enterprise-gateway-provisioning.md)
- [UWork 品牌、模式切换和界面规范](specs/uwork-branding.md)
- [UWork 独立数据根](specs/uwork-data-root-separation.md)
- [UI 设计规范](DESIGN.md) · [开发约定](AGENTS.md)

复现和排查问题时，请记录系统版本、提交版本、API 格式、脱敏后的路径和操作步骤，不要附带真实密钥。

## GitHub Actions 构建与发布

[桌面发布工作流](https://github.com/Jas0nxlee/UWork_frontend/actions/workflows/desktop-release.yml)使用 Node 24.14.0 / pnpm 10.33.2，先执行代码与依赖审计检查，再在原生 runner 上构建 macOS、Windows 和 Linux 安装包。

- macOS：DMG、ZIP；Windows：NSIS EXE；Linux：AppImage、DEB、RPM、Arch 包。
- `main` 的 push / PR 执行检查。推送与根版本一致的 `vX.Y.Z` 标签会构建并发布；也可在 Actions 的 Run workflow 中选择 `main`，开启 `publish` 后发布当前版本。
- 必须全部平台成功，且生产依赖审计没有 high/critical，才会汇总并公开 Release。每个安装包都有 SHA256，完整报告和源码提交随发布提供。
- macOS 当前使用 ad-hoc 签名，未经过 Apple 公证；Windows 当前未配置发布者签名。Linux AppImage 下载后需要添加执行权限。

安装包发布到 [GitHub Releases](https://github.com/Jas0nxlee/UWork_frontend/releases)，规则详见 [多平台发布 spec](specs/desktop-github-release.md) 和 [依赖安全修复](specs/release-dependency-hardening.md)。

## 许可

第一方代码采用 [Apache License 2.0](LICENSE)。原项目归属和第三方许可继续保留，参见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [第三方材料说明](third-party/)。
