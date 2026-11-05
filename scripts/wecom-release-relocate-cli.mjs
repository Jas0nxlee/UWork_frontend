import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { relocateWecomRelease } from "./wecom-release-relocate.mjs";
import { resolveTargetDirectoryConfig, runChild } from "./wecom-target-directory.mjs";
import { withWecomProxy } from "./wecom-release-proxy.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = resolveTargetDirectoryConfig(process.env);
    if (!process.env.TARGET_REPORT || !process.env.TARGET_HANDOFF || !process.env.RELEASE_JSON)
      throw new Error();
    if (process.argv.includes("--relocate-child")) {
      if (
        process.env.NODE_USE_ENV_PROXY !== "1" ||
        process.env.HTTPS_PROXY !== "http://127.0.0.1:17890" ||
        process.env.NO_PROXY !== ""
      )
        throw new Error();
      const report = await relocateWecomRelease({
        config,
        release: JSON.parse(await readFile(process.env.RELEASE_JSON, "utf8")),
        mode: process.env.MODE || "plan",
        expectedPlanDigest: process.env.EXPECTED_PLAN_DIGEST,
        sourceSyncVerified: process.env.SOURCE_SYNC_VERIFIED === "true",
        saveReport: (value) =>
          writeFile(process.env.TARGET_REPORT, JSON.stringify(value, null, 2) + "\n", {
            mode: 0o600,
          }),
        saveHandoff: (encryptedTarget) =>
          writeFile(process.env.TARGET_HANDOFF, JSON.stringify({ encryptedTarget }) + "\n", {
            mode: 0o600,
            flag: "wx",
          }),
      });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = ["success", "planned"].includes(report.status) ? 0 : 1;
    } else {
      if (!process.env.WECOM_PROXY_CONFIG?.trim()) throw new Error();
      process.exitCode = await withWecomProxy({
        env: process.env,
        runSync: (env, signal) => runChild(env, signal, import.meta.url, "--relocate-child"),
      });
    }
  } catch {
    console.error("[wecom-relocate] 固定配置或迁移执行失败；请核对安全进度报告，不盲目重发操作");
    process.exitCode = 1;
  }
}
