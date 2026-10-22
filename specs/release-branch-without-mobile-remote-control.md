# 发布分支移除手机远控

## 产品规则与所有者

- 本分支（`release/no-mobile-remote-control`）是发布线，不再提供「手机/浏览器远控桌面」能力。
  桌面端没有远控入口、不注册远控 IPC、不连接任何 relay、不读取手机页/中继地址配置；
  仓库内不再携带手机远控页的启动入口与 Android 壳（`packages/android`）。
- 已部署的中继服务与 `packages/relay` 源码保留：它是不进桌面安装包的独立服务端组件，
  由单独发布流程维护。本分支的客户端不再使用它，因此保留源码只作为外部服务合同，
  不构成客户端能力。
- 远程工作区 / Source Server（`packages/ui/src/remote-connection/*`、
  `packages/desktop/src/main/desktopRemoteSessions.ts` 的远端会话注册表）与手机远控是两条链路，
  保持原样。`workspaceIdentity`、`remoteSessionId`、`desktop-continuous` /
  `web-remote-replayable` 的既有语义不因本分支改名或删除。
- `packages/web` 不再是可部署的手机远控页：只保留被公开分享镜像（`packages/web-share`）复用的
  `src/auth`、`src/share`、`communityUrl`、`webThemeSeed` 与对应单测；页面入口、Vite 构建、
  relay 桥接、手机壳引导页全部删除。`material-icons` 素材随分享页迁到
  `packages/web-share/public/`。
- Bot / IM 通道配置原先只能从被删除的远控弹层进入；分支把入口迁到侧栏 footer 的
  `sidebar-bots-button`（`bots.manage.open`），能力不回退。
- 裁剪方式沿用 UWork 既有做法：删除产品入口与协议实现，保留与核心 UI 交织的布局/回放参数
  （`isWebRemoteControl*` 一类 prop 在桌面端恒为 false，不承担新语义），避免在发布线上
  重构会话运行时。手机页与 Android 壳删除后，这些参数没有置真来源。

## 已删除清单

| 位置                                                              | 内容                                             |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `packages/web/src/main.tsx`、`index.html`、`vite.config.ts`        | 手机/浏览器远控页 SPA 入口（`/remote/v4` 启动壳） |
| `packages/web/src/web-remote-control/**`                          | 手机页远控实现（relay 桥、配对、任务视图）       |
| `packages/android/`                                               | Android WebView 壳                               |
| `packages/desktop/src/main/web-remote-relay/**`                   | HMAC relay 客户端、鉴权、设备存储、V2 HTTP 客户端 |
| `packages/desktop/src/main/webRemoteControl*.ts`                  | 远控会话管理、IPC、状态事件、重连、特性开关      |
| `packages/desktop/src/main/desktopWebRemoteControlIpc.ts`         | 远控 IPC 注册与埋点                              |
| `packages/desktop/src/main/desktopMobileRemoteControlConfig.ts`   | 随包手机页/中继地址配置加载                      |
| `packages/ui/src/web-remote-control/**`、入口/弹层/MobileShell、开关组件 | 桌面弹层、二维码、手机壳、特性开关        |
| `packages/client/src/webRemoteControl*.ts`                        | 远控 relay 协议客户端                            |
| `config/mobile-remote-control.json`                               | 随包自建中继/手机页地址                          |
| `scripts/dev-web-remote-control-desktop.mjs`、`build:web-remote-control:*` | 远控开发/构建入口                      |
| `docs/web-remote-control/**`、远控相关 specs                      | 被删能力的文档与设计稿                           |

## 保留清单

- `packages/relay/`、`specs/web-remote-control-relay.md`：独立部署的中继服务及其协议合同。
  依赖手机页 transport 的契约用例随手机页删除；中继自身的鉴权、配对、限流、持久化用例保留。
- `packages/shared/src/web-remote-control*.ts`、`web-remote-relay/**`：保留的协议类型、分片传输与
  relay 消息解析，仍被中继、设置校验、`IPlatformService` 与 e2e 夹具引用。
- `packages/desktop/src/preload`、`renderer/src/desktopPlatform` 中的远控平台方法：main 已不再注册
  对应 handler，且特性开关默认关闭，因此不会被调用；保留声明避免在发布线上重构核心布局。
- `packages/ui` 中 `isWebRemoteControl*` 布局/回放参数与 `webRemoteControlWorkspaceSwitcher` 透传：
  没有置真来源，桌面恒为 false。
- 远程工作区 / Source Server 全部代码与测试；`web-remote-replayable` 作为既有模式值保留。
- `packages/desktop/test/e2e/**` 下标注 `manual-review/pending` 的手机场景用例保留（不进入自动门禁），
  在删除手机页后不再具备真实端到端可执行性，后续同步上游时一并收敛。

## 验收与回归

1. `pnpm typecheck` 全绿（根命令包含保留的 `packages/web` 源码子集，不含手机页入口）。
2. `pnpm lint` 无新增告警；`.oxlintrc.json` 删除已删文件的存量豁免。
3. 桌面启动路径不再创建远控 manager、不注册远控 IPC、不读 `config/mobile-remote-control.json`，
   进程不发起 relay WebSocket 连接。
4. 桌面侧栏 footer 无远控入口；机器人通道入口存在且可打开 `BotsDialog`。
5. 删除能力对应的单测一并删除；`pnpm test:unit` 的剩余失败与 `main` 基线一致（逐项比对），
   不把既有失败写成通过。
6. `scripts/build-zcode.mjs` 不再构建/装配手机页；分享镜像（`packages/web-share`）改用自带的
   `material-icons` 与 `webThemeSeed`，可独立构建。

## 回滚

从 `main` 重新切分支即可恢复全部能力；本分支不修改主线的协议与中继合同。
