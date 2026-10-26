# tool-json-schema

纯合同模块仅拥有既有 JSON Schema 转换器、DeferredToolCall 和 ToolSearch 的公开定义，不接管整个 contracts 或 CLI。`toToolJsonSchema` 保持原路径，是 runtime 输入校验到 provider 参数的唯一转换 owner。

- 保留 input 类型、范围、默认值、strict/strip 的 provider 合同及 ToolSearch 显式 required 覆盖。
- 循环或不可表示类型必须失败，不能发布任意 schema 掩盖错误；无 IO、可变状态、队列或另一条写入路径。
- 三个既有文件继续公开，治理目录仅提供类型、示例、测试与模块声明。其它工具消费同一转换器。
