# ui-database-startup

只展示 DatabaseStartupState，复用应用启动页、错误码、诊断复制、显式 retry/exit。

- 冷数据目录迁移用 operation 标签区分文案，不创建第二个状态机，也不开放业务服务。
- phase、attemptId 和 retry 资格来自启动 owner；UI 不从超时推断迁移完成。
- 组件不接触源/目标 Repo，不提交 dataBaseDir，不携带私有目录或消息内容。
