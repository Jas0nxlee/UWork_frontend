# data-directory-startup

Electron 的冷启动生命周期门禁，复用 DatabaseStartupCoordinator 与 GlobalDatabaseStartupLoading。业务复制与设置提交由 services/data-directory-startup 在独立 Worker 中唯一执行。

- 薄入口保持 main/index.js 产物路径，常规 Main 在冷请求完成后动态导入；无 pending 时直接进入原路径。
- pre-ready 生命周期配置幂等执行，包括 SDK 模块顶层 scheme 注册与完整的 media/plugin/rum 权限集合；SDK 的业务初始化仍在迁移提交后。请求锁在存储 owner，不在 Main 另存业务状态。
- `prepare` 完成只证明 Worker 已关闭、文件/设置事务完成；业务 Main/Host/Scheduler 此后才可初始化。
- 失败不进入业务路径；retry 与经 owner 确认未提交的取消分别接纳当前 attemptId，过期控制不影响下一轮。取消保留旧活动根和已复制内容；exit 仅终止本 Worker，不终止其他应用。
- cold 窗口到实际业务 renderer 窗口 ready 后才移除；about:blank 或其他辅助页不能作为接班证明。冷页不调用尚未注册的业务 Main 追踪 handler。
