/** Host 只提供组织归属；CLI 独占会话内容的导入与写入。 */
export interface OwnedLegacySession {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface LegacySessionOwnershipManifest {
  schemaVersion: 1;
  sessions: OwnedLegacySession[];
}

/** 数据库路径只由 CLI 配置 owner 解析，Host 不能镜像项目配置或猜测会话库。 */
export type SessionDatabaseRouteResolver = (session: OwnedLegacySession) => {
  path: string;
  explicitlyConfigured: boolean;
};

export interface SessionDatabaseMigrationOptions {
  sourcePath: string;
  targetPath: string;
  ownershipManifestPath: string;
  resolveSessionDatabase?: SessionDatabaseRouteResolver;
  onProgress?: (phase: "copying" | "verifying" | "activating") => Promise<void>;
}

export interface SessionDatabaseMigrationResult {
  status: "fresh" | "migrated" | "already-migrated";
  importedSessions: number;
}

/** 原库只读；完成持久化后返回；相同目标重复调用不重复导入。 */
export interface SessionDatabaseMigrationContract {
  migrate(options: SessionDatabaseMigrationOptions): Promise<SessionDatabaseMigrationResult>;
  /** 完成账本与活动库标记同时有效；未开始/未完成返回 false，完成后损坏则报错。 */
  isPrepared(options: { sourcePath: string; targetPath: string }): Promise<boolean>;
  /** 没有完成启动迁移时禁止业务 Agent 抢先创建空目标库。 */
  assertReady(options: { sourcePath: string; targetPath: string }): Promise<void>;
}
