import { expect, it } from "vitest";
import { classifyDatabaseStartupError, databaseStartupErrorCodeSchema } from "./contract.js";
it("结构化启动失败跨进程保持错误语义", () => {
  expect(classifyDatabaseStartupError({ code: "ENOSPC" })).toBe("storage_full");
  expect(databaseStartupErrorCodeSchema.parse("legacy_writer_active")).toBe("legacy_writer_active");
  expect(databaseStartupErrorCodeSchema.safeParse("unrecognized").success).toBe(false);
});

it.each([
  ["SESSION_MIGRATION_OWNERSHIP", "session_ownership_unknown"],
  ["SESSION_MIGRATION_SOURCE_CHANGED", "session_source_changed"],
  ["DATA_DIRECTORY_TARGET_CONFLICT", "data_directory_target_conflict"],
])("稳定结构化 code %s 保持安全门禁语义", (code, expected) => {
  expect(databaseStartupErrorCodeSchema.parse(expected)).toBe(expected);
  expect(
    classifyDatabaseStartupError(Object.assign(new Error("unrelated message"), { code })),
  ).toBe(expected);
  expect(classifyDatabaseStartupError(new Error(code))).toBe("sql_failed");
  expect(classifyDatabaseStartupError({ code, cause: { code: "ENOSPC" } })).toBe("storage_full");
  expect(classifyDatabaseStartupError({ code, cause: { code: "EACCES" } })).toBe(
    "permission_denied",
  );
  expect(classifyDatabaseStartupError({ code, errcode: 13 })).toBe("storage_full");
});
