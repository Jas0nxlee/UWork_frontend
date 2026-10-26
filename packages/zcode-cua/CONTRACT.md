# cua-runtime

UWork 本地桌面的电脑控制运行时。独立 macOS Helper.app 是原生驱动、TCC 权限与输入队列的唯一所有者，公开端口保持现有 `@zcode/zcode-cua` 入口兼容。

- Host 验签安装并按需启动 Helper，Main 复用既有权限引导，Renderer 只展示 Helper 返回的状态。
- shared node_repl 先向 Host 发现连接，再以私有 Unix socket 和随机 authority 直接请求 Helper 执行；Host 不得代理动作，以保留真实 peer 校验。不加载原生驱动。只读权限预检无提示、无抓屏，未知状态不得推导为拒绝授权。
- 执行在 Helper 串行 admission；workspace identity、remote session、session 共同隔离，stop/abort 在 admission 时再判；拒绝远端和 subagent 桌面控制。
- 安装来源仅限显式 bundled Helper。正式包执行签名/team/架构校验，开发态 ad-hoc 例外必须显式开启。替换与重启保留 transport/owner 边界。
- 详细事件顺序、平台范围和验收见 `specs/restore-macos-computer-use-runtime.md`。公开驱动和协议适配来源须保留许可证。
