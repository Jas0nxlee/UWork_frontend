import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { classifyDatabaseStartupError } from "@zcode/shared";
import {
  assertNoLegacySessionWriters,
  collectLegacySessionWriters,
} from "../src/host/database-startup/legacySessionWriterGate.js";

describe("legacy session writer gate", () => {
  it.runIf(process.platform === "darwin")(
    "macOS real lsof detects an owned live CLI fixture and clears after exit",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "uwork-writer-real-"));
      const source = join(dir, "db.sqlite");
      await writeFile(source, "isolated file fixture");
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.title='uwork-cli';require('node:fs').openSync(process.argv[1],'r+');process.send('ready');setInterval(()=>{},1000);`,
          source,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      try {
        await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error("fixture exited before ready");
          }),
        ]);
        await expect(assertNoLegacySessionWriters(source)).rejects.toMatchObject({
          kind: "legacy_writer_active",
        });
        const exited = once(child, "exit");
        child.kill();
        await exited;
        await expect(assertNoLegacySessionWriters(source)).resolves.toBeUndefined();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it("blocks possible writers and maps unknown inventory to the existing failure projection", async () => {
    const active = await assertNoLegacySessionWriters("/legacy/db.sqlite", async () => [
      process.pid + 1,
    ]).catch((error) => error);
    expect(classifyDatabaseStartupError(active)).toBe("legacy_writer_active");
    const unknown = await assertNoLegacySessionWriters("/legacy/db.sqlite", async () => {
      throw Object.assign(new Error("not permitted"), { code: "EACCES" });
    }).catch((error) => error);
    expect(classifyDatabaseStartupError(unknown)).toBe("legacy_writer_check_failed");
    await expect(
      assertNoLegacySessionWriters("/legacy/db.sqlite", async () => [process.pid]),
    ).resolves.toBeUndefined();
  });

  it("macOS correlates exact source/WAL holders with CLI names and does not treat tool failures as an empty inventory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-writer-mac-"));
    const source = join(dir, "db.sqlite");
    await writeFile(source, "fixture");
    await writeFile(`${source}-wal`, "wal");
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "lsof") {
        expect(args.slice(0, 2)).toEqual(["-t", "--"]);
        expect(args.slice(2)).toEqual([await realpath(source), await realpath(`${source}-wal`)]);
        return { stdout: "41001\n41002\n", stderr: "", code: 0 };
      }
      expect(command).toBe("ps");
      return {
        stdout: "41001 uwork-cli uwork-cli\n41002 sqlite3 sqlite3 fixture\n",
        stderr: "",
        code: 0,
      };
    });
    try {
      expect(await collectLegacySessionWriters(source, { platform: "darwin", run })).toEqual([
        41001,
      ]);
      await expect(
        assertNoLegacySessionWriters(source, () =>
          collectLegacySessionWriters(source, {
            platform: "darwin",
            run: async () => ({ stdout: "", stderr: "permission denied", code: 1 }),
          }),
        ),
      ).rejects.toMatchObject({ kind: "legacy_writer_check_failed" });
      await expect(
        assertNoLegacySessionWriters(source, () =>
          collectLegacySessionWriters(source, {
            platform: "darwin",
            run: async () => {
              throw Object.assign(new Error("missing lsof"), { code: "ENOENT" });
            },
          }),
        ),
      ).rejects.toMatchObject({ kind: "legacy_writer_check_failed" });
      expect(
        await collectLegacySessionWriters(source, {
          platform: "darwin",
          run: async () => ({ stdout: "", stderr: "", code: 1 }),
        }),
      ).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Linux uses current-UID source file descriptors rather than only a process title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-writer-proc-"));
    const source = join(dir, "db.sqlite");
    const procRoot = join(dir, "proc");
    const pid = process.pid + 100;
    const processRoot = join(procRoot, String(pid));
    await writeFile(source, "fixture");
    await mkdir(join(processRoot, "fd"), { recursive: true });
    await writeFile(join(processRoot, "comm"), "uwork-cli\n");
    await writeFile(join(processRoot, "cmdline"), "uwork-cli\0app-server\0");
    await symlink(source, join(processRoot, "fd", "3"));
    try {
      expect(
        await collectLegacySessionWriters(source, {
          platform: "linux",
          procRoot,
          uid: process.getuid?.() ?? 0,
        }),
      ).toEqual([pid]);
      await rm(join(processRoot, "fd", "3"));
      expect(
        await collectLegacySessionWriters(source, {
          platform: "linux",
          procRoot,
          uid: process.getuid?.() ?? 0,
        }),
      ).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Windows conservatively blocks current-user bundled app-server candidates and fails closed on CIM errors", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      expect(args.join(" ")).toContain("GetOwner");
      return {
        stdout: JSON.stringify([{ pid: process.pid }, { pid: process.pid + 1 }]),
        stderr: "",
        code: 0,
      };
    });
    expect(
      await collectLegacySessionWriters("C:\\legacy\\db.sqlite", { platform: "win32", run }),
    ).toEqual([process.pid + 1]);
    await expect(
      assertNoLegacySessionWriters("C:\\legacy\\db.sqlite", () =>
        collectLegacySessionWriters("C:\\legacy\\db.sqlite", {
          platform: "win32",
          run: async () => ({ stdout: "[]", stderr: "access denied", code: 1 }),
        }),
      ),
    ).rejects.toMatchObject({ kind: "legacy_writer_check_failed" });
  });
});
