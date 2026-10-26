# UWork Computer Use Helper 安装与授权

当前 macOS 实现使用公开的 `@trycua/cua-driver@0.28.2`，驱动只在独立 SEA Helper.app 内加载。恢复规则见 [恢复 spec](../../specs/restore-macos-computer-use-runtime.md)。

## 唯一安装来源

正式 App 仅安装自己随包携带的 `UWork.app/Contents/Resources/cua-helper/ZCode Computer Use.app`。运行时不下载、不回退到其他 App 或旧开发副本。安装到 UWork 数据根的 `computer-use/` 下；preview 与显式 `ZCODE_CUA_HELPER_INSTALL_VARIANT` 使用独立子目录。数据根沿用 `ZCODE_STORAGE_DIR` / UWork 数据根规则。

正式来源在安装前与每次授权准备时校验 bundle id、目标架构、完整签名、可信 TeamIdentifier 与 Gatekeeper。默认签名锚点来自已验签的外层 UWork App；显式 team 配置必须匹配该来源。未签名、ad-hoc、来源不明或身份不一致均拒绝。

安装先复制到同一安装根的 staging 并复核，再将既有目录转为 backup、原子提升新目录；失败恢复 backup。相同版本仍比较真实内容，不能保留已过期 ABI 或旧签名产物。

## 开发与构建

使用 `mise.toml` 固定的 Node 24.14.0 / pnpm 10.33.2，从仓库根运行：

```bash
node scripts/build-cua-helper-app.mjs --allow-unsigned-launcher-local-dev
pnpm dev:desktop
```

开发产物为 `packages/desktop/dist-cua-helper/ZCode Computer Use Dev.app`，bundle id 为 `dev.zcode.cua-helper.dev`。标准 dev 入口注入该路径与 `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`，正式打包 App 会清除这个环境例外。

开发进程绕过生产 peer 签名校验还必须同时满足编译期 development policy 和显式两个 argv：`--allow-unsigned-launcher-local-dev`、`--allow-external-broker-client-local-dev`。生产 Helper 不接受这些 argv 作为例外。

随包产物运行 `pnpm --filter @zcode/desktop prepare:macos-cua-helper`。构建脚本暂存目标平台驱动及许可证、构建 SEA、编译 peer validator、先签内层原生文件再签 Helper，并执行签名校验。没有 Developer ID 时的 ad-hoc 产物只用于开发验证，正式签名与公证需在正式构建环境完成。

SEA 使用 Node 24.14 的 `execArgvExtension: none`，禁止 `NODE_OPTIONS` 在鉴权前预加载外部脚本。验收使用 `node scripts/test/native-cua-helper-smoke.mjs`；该命令执行权限预检和应用枚举，不截图、不发送输入、不修改 TCC。

## 权限与责任

- Helper 自己调用只读 `currentMacOsPermissionStatus()`；状态查询不弹权限窗口、不截图。
- Main 沿用现有授权单会话，打开对应系统设置，并提供已验签 Helper 的拖拽入口。用户授权返回后，Host 显式重启同一 Helper，并用短命进程读取新 TCC 状态。
- 匿名 ping 与权限预检不返回应用内容。执行、会话关闭与进程退出同时要求随机 authority 和内核 peer / 签名祖先校验；没有 verifier 不能提供控制能力。
- 窗口 Host 只断开自己的路由，不关闭其他窗口共享的 Helper。物理 Helper 在 300 秒没有请求且没有在途调用时退出；显式权限恢复保留 socket/authority 重启。
- 崩溃 socket 只在 owned 0700 目录、同 UID、明确 ECONNREFUSED 且 inode/dev 未改变时回收，不覆盖活跃或身份不明的 endpoint。

## 原生资源与平台

Helper 沿用 `packages/desktop/build/entitlements.helper.plist` 的最小集：`allow-jit` 与 `allow-unsigned-executable-memory`。驱动 `.node`、`.dylib` 与 peer validator 都按 Helper 身份签名，不新增 `disable-library-validation` 或 `allow-dyld-environment-variables`。

Windows/Linux 不携带这套 macOS Helper。生产能力由 `zcodeCuaPlatforms` 与打包门共同决定，不能仅移除占位标记就声称所有平台已恢复。
