# 电脑控制权限设置回归

产品合同：[macOS 电脑控制运行时恢复](../../specs/restore-macos-computer-use-runtime.md)。
显式导航修复合同：[电脑控制设置的显式系统面板入口](../../specs/computer-use-explicit-settings-entry.md)。

候选用例：`packages/desktop/test/e2e/settings/manual-review/pending/computer-use-permission-settings.test.ts`。
仅使用 WDIO 隔离 HOME、夹具 workspace 与独立 Helper 安装 variant；不读取用户生产任务或配置。
本例不发起模型推理请求；pending 回放入口仍显式指定 `common.json` 满足 runner 合同，不增加业务模型响应 fixture。
首跑通过产品的「跳过登录」和退出职业引导操作进入夹具工作区。

| 编号    | 准备                                                         | 操作                             | 断言                                                                                                         |
| ------- | ------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| CUPS-01 | 当前源码构建的 Dev Helper；电脑控制插件启用；不要求系统缺权  | 设置→电脑控制→打开辅助功能设置   | 不以状态查询为导航前置条件，Main 向 `shell.openExternal` 传入精确 Accessibility URL；Helper 返回真实明确状态 |
| CUPS-02 | 同上；退出上一分区取消尚未返回的引导 participant，再重新进入 | 打开屏幕录制设置                 | Main 向 `shell.openExternal` 传入精确 ScreenCapture URL；无 Helper 状态未知提示                              |
| CUPS-03 | 同一设置页中 Accessibility 引导仍在等待返回                  | 直接点击屏幕录制设置，不离开分区 | 取消本 Renderer 旧 participant 后，Main 清理旧 session 并打开精确 ScreenCapture URL；无需先完成授权          |

`shell.openExternal` 使用 Electron mock，防止自动测试打开或修改 macOS 授权页。
Helper、Host 权限服务的展示查询、Renderer→Main IPC 和 Helper 安装验签均走实际链路；设置按钮不再前置预检或裁剪用户选择。
因此此例证明按钮路由和可用权限状态，系统设置的真实显示及用户授权返回需要单独记录真机证据。

运行前先完成源码桌面 E2E 构建与 Dev Helper 构建；复用构建时不得同时写共享 `out`：

```bash
UWORK_DESKTOP_BUILD_PROFILE=local-development \
ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_SKIP_BUILD=1 \
ZCODE_E2E_SKIP_AGENT_BUILD=1 \
ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE=replay \
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
ZCODE_E2E_HOME_DIR=/tmp/uwork-computer-use-settings-e2e \
ZCODE_CUA_HELPER_INSTALL_VARIANT=e2e-permission-settings \
ZCODE_CUA_BUNDLED_HELPER_APP_PATH="$PWD/packages/desktop/dist-cua-helper/ZCode Computer Use Dev.app" \
ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1 \
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/settings/manual-review/pending/computer-use-permission-settings.test.ts'
```

本例保持 pending，人工审阅前不进入正式回放和 CI 准入集合。

源码 E2E 构建必须使用同一 `local-development` 编译档位，不能仅给正式编译产物注入开发环境变量。

新增 React 交互回归覆盖：检查中按钮可用、旧展示 denied 而新查询可 grant 时仍导航、已授权入口保留、连续点击先取消旧 operation、卸载与 workspace 切换的迟到结果隔离。新 CUPS-03 的实际执行证据需在回放后追加。

## 2026-10-26 初轮验证记录（显式导航修复前）

- 最终 WDIO run：`desktop-e2e-20261026052340429-p51532-07abbad7b4fdd130`，1 个 spec、2 个场景通过。
- 证据：`packages/desktop/.e2e-artifacts/<run>/summary.md`、`summary.json` 与 `runtime-logs/0-0/desktop/2026-10-26.log`。
- 本轮重新构建当前 Renderer，实测同一 App 中连续完成两项入口：真实 Dev Helper 的 bundle id/pid 与两项 `denied` 状态、精确系统设置 URL、无 unknown toast、切换 General 卸载后取消授权并销毁原生面板。
- 回归发现并修复 `desktopPlatform` 遗漏取消桥接：补前聚焦单测因方法为 undefined 失败；补后通过，连续两按钮 E2E 同时通过。
- Agent 构建还暴露旧 Sharp 暂存门控误判，现复用 `isSharpRequiredByComputerUse`；相关 9 条聚焦测试与当前真实清单的暂存调用通过。未新增 Sharp 依赖。
- 使用 Electron 41.10.7、Node 24.14.0；Helper 为本机 Dev/ad-hoc 构建。此记录不等同于正式签名、公证包及真实系统授权返回验收。
